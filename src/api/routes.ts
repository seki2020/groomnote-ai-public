import { Hono } from "hono";
import { z } from "zod";
import { analyzeDeterministically } from "../analysis/fake-llm";
import {
  AnalysisUnavailableError,
  extractionToHandover,
  safeAnalysisFailureDiagnostics,
  WorkersAIAnalyzer,
} from "../analysis/workers-ai";
import { fakeMp3, fakeWav, MP3_CONTENT_TYPE, WAV_CONTENT_TYPE, WorkersAITts } from "../audio/tts";
import {
  releaseSpeechRequest,
  reserveSpeechRequest,
  resolveAuthorizedUtterance,
} from "../audio/speech";
import { deserializeHandoverContent, identifierSchema } from "../persistence/schemas";
import {
  approveAndSave,
  cancelSession,
  createDraft,
  getSession,
  reviewCurrentDraft,
  transitionSession,
} from "../state-machine/service";
import { correctionOptions, getCorrection, recoverCorrection, replayCorrection, type CorrectionRequest } from "../state-machine/correction";
import type { Bindings } from "../types";
import {
  AssemblyAITokenProvider,
  FailingTokenProvider,
  FakeTokenProvider,
} from "../stt/assemblyai";
import {
  abandonSttRound,
  completeSttConnection,
  issueSttToken,
  resolveDailySttTokenIssuanceLimit,
  resolveSessionSttTokenIssuanceLimit,
} from "../stt/service";
import { hashCredential, requireDemoCredential, requireSessionCredential } from "./auth";
import { ApiError } from "./errors";
import { MAX_API_REQUEST_BYTES } from "../security/request";
import { BUSINESS_SESSION_DURATION_MS, cleanupExpiredSessions } from "../security/session";
import { verifyTurnstile } from "../security/turnstile";
import {
  hackathonMode,
  HACKATHON_USAGE_LIMIT,
  assertCorrectionAvailable,
  assertFollowUpAvailable,
  reserveProviderInvocation,
} from "../security/usage";
import {
  addTurnRequestSchema,
  approveRequestSchema,
  correctionRequestSchema,
  createSessionRequestSchema,
  completedFollowUpRoundSchema,
  publicSessionRequestSchema,
  replyRequestSchema,
  speechRequestSchema,
} from "./schemas";

const api = new Hono<{ Bindings: Bindings }>();

function sessionIdFrom(context: { req: { param(name: string): string } }): string {
  const result = identifierSchema.safeParse(context.req.param("id"));
  if (!result.success) throw new ApiError(422, "VALIDATION_ERROR", "The session ID is invalid.");
  return result.data;
}

async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_API_REQUEST_BYTES) {
      throw new ApiError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
    }
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, "VALIDATION_ERROR", "The request body is invalid.");
  return result.data;
}

async function ensureRound(db: D1Database, sessionId: string): Promise<string> {
  const existing = await db
    .prepare(
      "SELECT id FROM stt_rounds WHERE session_id = ? AND status = 'OPEN' ORDER BY round_number DESC LIMIT 1",
    )
    .bind(sessionId)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM stt_rounds WHERE session_id = ?")
    .bind(sessionId)
    .first<{ count: number }>();
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO stt_rounds (id, session_id, round_number, status) VALUES (?, ?, ?, 'OPEN')",
    )
    .bind(id, sessionId, (count?.count ?? 0) + 1)
    .run();
  return id;
}

async function insertTextTurn(
  db: D1Database,
  sessionId: string,
  providerTurnId: string,
  transcript: string,
  allowedStates: readonly string[] = ["COLLECTING"],
): Promise<void> {
  const state = (await getSession(db, sessionId)).state;
  if (!allowedStates.includes(state)) {
    throw new ApiError(409, "INVALID_STATE", "The session is not collecting turns.");
  }
  const roundId = state === "AWAITING_FOLLOWUP"
    ? (await db.prepare(
        "SELECT id FROM stt_rounds WHERE session_id = ? AND status = 'OPEN' LIMIT 1",
      ).bind(sessionId).first<{ id: string }>())?.id
    : await ensureRound(db, sessionId);
  if (!roundId) throw new ApiError(409, "STT_ROUND_REQUIRED", "Start a follow-up transcription round before submitting turns.");
  await db
    .prepare(
      `INSERT INTO transcript_turns
         (id, session_id, stt_round_id, provider_turn_id, transcript)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, provider_turn_id) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), sessionId, roundId, providerTurnId, transcript)
    .run();
}

async function assertNoKnownPetConflict(
  db: D1Database,
  sessionId: string,
  additionalTranscript?: string,
): Promise<void> {
  const appointmentPet = await db.prepare(
    `SELECT p.name FROM sessions s JOIN appointments a ON a.id = s.appointment_id
     JOIN pets p ON p.id = a.pet_id WHERE s.id = ?`,
  ).bind(sessionId).first<{ name: string }>();
  if (!appointmentPet) throw new ApiError(404, "SESSION_NOT_FOUND", "The session was not found.");
  const turns = await db.prepare(
    "SELECT transcript FROM transcript_turns WHERE session_id = ?",
  ).bind(sessionId).all<{ transcript: string }>();
  const transcript = [...turns.results.map(turn => turn.transcript), additionalTranscript ?? ""].join(" ");
  const names = new Set<string>();
  for (const match of transcript.matchAll(/\b([A-Z][a-z]+)\s+(?:was|had|is|received)\b/g)) names.add(match[1]);
  for (const match of transcript.matchAll(/\bgroomed\s+([A-Z][a-z]+)\b/g)) names.add(match[1]);
  for (const name of names) {
    if (name.toLowerCase() === appointmentPet.name.toLowerCase() ||
        ["he", "she", "it", "they", "we", "i", "this", "that", "today"].includes(name.toLowerCase())) continue;
    const otherPet = await db.prepare(
      "SELECT id FROM pets WHERE lower(name) = lower(?) LIMIT 1",
    ).bind(name).first<{ id: string }>();
    if (otherPet) {
      throw new ApiError(409, "PET_IDENTITY_CONFLICT", "The transcript names a different known pet from the appointment. Create the correct session.");
    }
  }
}

async function analyzeSession(
  env: Bindings,
  sessionId: string,
  options: {
    hasFollowUpAnswer: boolean;
    correctionInstruction?: string;
    correctionRequest?: CorrectionRequest;
    currentDraft?: ReturnType<typeof deserializeHandoverContent>;
  },
) {
  const identity = await env.DB
    .prepare(
      `SELECT p.name AS petName, p.breed FROM sessions s
       JOIN appointments a ON a.id = s.appointment_id
       JOIN pets p ON p.id = a.pet_id WHERE s.id = ?`,
    )
    .bind(sessionId)
    .first<{ petName: string; breed: string | null }>();
  const turns = await env.DB
    .prepare("SELECT transcript FROM transcript_turns WHERE session_id = ? ORDER BY created_at, id")
    .bind(sessionId)
    .all<{ transcript: string }>();
  if (!identity || turns.results.length === 0) {
    throw new ApiError(409, "INSUFFICIENT_INPUT", "At least one transcript turn is required.");
  }
  const transcripts = turns.results.map((turn) => turn.transcript);
  if (env.ANALYZER_MODE === "fake") {
    return analyzeDeterministically({
      petName: identity.petName,
      transcripts,
      hasFollowUpAnswer: options.hasFollowUpAnswer,
      correctionInstruction: options.correctionInstruction,
      currentDraft: options.currentDraft,
    });
  }
  if (env.ANALYZER_MODE === "fake-error") {
    throw new AnalysisUnavailableError(new Error("Deterministic analysis failure."));
  }
  const analyzer = new WorkersAIAnalyzer(
    env.AI as unknown as import("../analysis/workers-ai").AiRunner,
    details => console.warn("Workers AI attempt failed.", details),
    hackathonMode(env),
  );
  let correctionClarification: { question: string; answer: string } | undefined;
  if (options.correctionRequest?.last_round_id) {
    const question = await env.DB.prepare("SELECT payload_json AS payloadJson FROM session_events WHERE session_id = ? AND event_type = 'FOLLOW_UP_ASKED' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .bind(sessionId).first<{ payloadJson: string }>();
    const answer = await env.DB.prepare("SELECT transcript FROM transcript_turns WHERE session_id = ? AND stt_round_id = ? ORDER BY created_at, rowid")
      .bind(sessionId, options.correctionRequest.last_round_id).all<{ transcript: string }>();
    if (question && answer.results.length) correctionClarification = {
      question: (JSON.parse(question.payloadJson) as { question: string }).question,
      answer: answer.results.map(turn => turn.transcript).join(" "),
    };
  }
  const extraction = await analyzer.analyze({
    petName: identity.petName,
    breed: identity.breed,
    transcripts,
    hasFollowUpAnswer: options.hasFollowUpAnswer,
    correctionInstruction: options.correctionInstruction,
    correctionClarification,
    currentDraft: options.currentDraft,
  });
  if (extraction.needs_follow_up) {
    return { kind: "follow_up" as const, question: extraction.follow_up_question! };
  }
  return {
    kind: "draft" as const,
    content: extractionToHandover(extraction),
    spokenSummary: extraction.concise_spoken_summary,
  };
}

async function completeAnalysis(
  env: Bindings,
  sessionId: string,
  options: Parameters<typeof analyzeSession>[2],
) {
  const analysis = await analyzeSession(env, sessionId, options);
  if (analysis.kind === "follow_up") {
    await assertFollowUpAvailable(env.DB, sessionId, hackathonMode(env));
    const latestRound = await env.DB.prepare(
      "SELECT COALESCE(MAX(round_number), 0) AS roundNumber FROM stt_rounds WHERE session_id = ?",
    ).bind(sessionId).first<{ roundNumber: number }>();
    const current = await getSession(env.DB, sessionId);
    const payload = JSON.stringify({ question: analysis.question, afterRoundNumber: latestRound?.roundNumber ?? 0 });
    if (!["ANALYZING", "CORRECTING"].includes(current.state)) throw new ApiError(409, "INVALID_STATE", "The session is not analyzing a report or correction.");
    // State, authorized speech and correction result commit together.
    const statements = [
      env.DB.prepare("UPDATE sessions SET state = 'AWAITING_FOLLOWUP', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = ? AND current_draft_revision = ?")
        .bind(sessionId, current.state, current.currentDraftRevision),
      env.DB.prepare("INSERT INTO session_events (id, session_id, event_type, payload_json) VALUES (?, ?, 'FOLLOW_UP_ASKED', ?)")
        .bind(crypto.randomUUID(), sessionId, payload),
    ];
    if (options.correctionRequest) statements.push(env.DB.prepare(
      "UPDATE correction_requests SET status = 'AWAITING_FOLLOWUP', result_json = ? WHERE session_id = ? AND provider_turn_id = ? AND status = 'PROCESSING'",
    ).bind(JSON.stringify({ action: "follow_up", question: analysis.question }), sessionId, options.correctionRequest.provider_turn_id));
    const results = await env.DB.batch(statements);
    if (results[0].meta.changes !== 1) throw new Error("Concurrent follow-up transition detected.");
    return { action: "follow_up" as const, question: analysis.question };
  }
  const revision = await createDraft(env.DB, {
    id: crypto.randomUUID(),
    sessionId,
    content: analysis.content,
    spokenSummary: analysis.spokenSummary,
    correctionTurnId: options.correctionRequest?.provider_turn_id,
  });
  return { action: "review" as const, revision };
}

function providerFailure(error: AnalysisUnavailableError, fallbackCode: string, fallbackMessage: string, bypassQuotas: boolean): ApiError {
  const details = safeAnalysisFailureDiagnostics(error);
  if (details.providerReason === "daily_provider_limit" || details.providerCode === 3036) {
    if (bypassQuotas) return new ApiError(503, "AI_PROVIDER_LIMIT_REPORTED",
      "The AI provider request failed with a reported limit. Application quotas are bypassed; the upstream cause requires investigation. Your session remains available.");
    return new ApiError(429, "AI_DAILY_ALLOWANCE_EXHAUSTED",
      "Cloudflare Workers AI daily allowance is exhausted. Enable the Workers Paid plan or wait for the provider allowance to reset. Your session remains available.");
  }
  if (details.providerReason === "paid_plan_required" || details.providerCode === 5035) {
    return new ApiError(403, "AI_PAID_PLAN_REQUIRED", "Cloudflare requires the Workers Paid plan for this AI request.");
  }
  return new ApiError(503, fallbackCode, fallbackMessage);
}

async function completeAnalysisRecovering(
  env: Bindings,
  sessionId: string,
  restoreState: "COLLECTING" | "AWAITING_FOLLOWUP",
  options: Parameters<typeof analyzeSession>[2],
) {
  try {
    return await completeAnalysis(env, sessionId, options);
  } catch (error) {
    await env.DB.prepare(
      "UPDATE sessions SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = 'ANALYZING'",
    ).bind(restoreState, sessionId).run();
    if (error instanceof AnalysisUnavailableError) {
      if (env.APP_ENV === "development" && env.ANALYZER_MODE === "workers-ai") {
        console.warn("Workers AI analysis exhausted bounded retries.", safeAnalysisFailureDiagnostics(error));
      }
      throw providerFailure(error, "ANALYSIS_UNAVAILABLE", "Analysis is unavailable. The transcript remains available; try again.", hackathonMode(env));
    }
    throw error;
  }
}

async function createBusinessSession(db: D1Database, appointmentId: string) {
  const appointment = await db.prepare(
    `SELECT a.id, p.name AS petName FROM appointments a
     JOIN pets p ON p.id = a.pet_id WHERE a.id = ?`,
  )
    .bind(appointmentId)
    .first<{ id: string; petName: string }>();
  if (!appointment) throw new ApiError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found.");

  const id = crypto.randomUUID();
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  await db.prepare(
    `INSERT INTO sessions (id, appointment_id, state, expires_at, session_token_hash)
     VALUES (?, ?, 'CREATED', ?, ?)`,
  )
    .bind(
      id,
      appointmentId,
      new Date(Date.now() + BUSINESS_SESSION_DURATION_MS).toISOString(),
      await hashCredential(token),
    )
    .run();
  await transitionSession(db, id, "OPENING");
  await transitionSession(db, id, "COLLECTING");
  return {
      id,
      sessionToken: token,
      state: "COLLECTING",
      openingPrompt: "PUBLIC_OPENING_COPY_PLACEHOLDER",
    };
}

api.post("/sessions", async (context) => {
  await requireDemoCredential(context.req.raw, context.env.DEMO_API_KEY);
  await cleanupExpiredSessions(context.env.DB);
  const body = await parseJson(context.req.raw, createSessionRequestSchema);
  return context.json(await createBusinessSession(context.env.DB, body.appointmentId), 201);
});

const MAX_DAILY_PUBLIC_SESSIONS = 100;

api.post("/public/sessions", async (context) => {
  const origin = context.req.header("Origin");
  if (!origin || origin !== context.env.CORS_ALLOWED_ORIGIN) {
    throw new ApiError(403, "ORIGIN_FORBIDDEN", "This browser origin is not allowed.");
  }
  const body = await parseJson(context.req.raw, publicSessionRequestSchema);
  // Avoid Siteverify traffic when the local business-session quota is already full.
  const usage = await context.env.DB.prepare(
    "SELECT session_creations AS count FROM daily_public_session_usage WHERE quota_date = date('now')",
  ).first<{ count: number }>();
  if (!hackathonMode(context.env) && (usage?.count ?? 0) >= MAX_DAILY_PUBLIC_SESSIONS) {
    throw new ApiError(429, "PUBLIC_SESSION_QUOTA_EXCEEDED", "The daily browser session limit is exhausted.");
  }
  await verifyTurnstile(body.turnstileToken, context.env.TURNSTILE_SECRET_KEY, origin, fetch, context.env.APP_ENV !== "production");
  await cleanupExpiredSessions(context.env.DB);
  await context.env.DB.prepare(
    "INSERT OR IGNORE INTO daily_public_session_usage (quota_date) VALUES (date('now'))",
  ).run();
  const reserved = await context.env.DB.prepare(
    `UPDATE daily_public_session_usage SET session_creations = session_creations + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE quota_date = date('now') AND session_creations < ?`,
  ).bind(hackathonMode(context.env) ? HACKATHON_USAGE_LIMIT : MAX_DAILY_PUBLIC_SESSIONS).run();
  if (reserved.meta.changes !== 1) {
    throw new ApiError(429, "PUBLIC_SESSION_QUOTA_EXCEEDED", "The daily browser session limit is exhausted.");
  }
  try {
    return context.json(await createBusinessSession(context.env.DB, body.appointmentId), 201);
  } catch (error) {
    await context.env.DB.prepare(
      "UPDATE daily_public_session_usage SET session_creations = session_creations - 1 WHERE quota_date = date('now') AND session_creations > 0",
    ).run();
    throw error;
  }
});

api.get("/sessions/:id", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const session = await getSession(context.env.DB, id);
  if (session.state !== "AWAITING_FOLLOWUP") return context.json(session);
  const event = await context.env.DB.prepare("SELECT payload_json AS payloadJson FROM session_events WHERE session_id = ? AND event_type = 'FOLLOW_UP_ASKED' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(id).first<{ payloadJson: string }>();
  const payload = event ? JSON.parse(event.payloadJson) as { question: string } : null;
  return context.json({ ...session, question: payload?.question });
});

api.post("/sessions/:id/turns", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, addTurnRequestSchema);
  await insertTextTurn(context.env.DB, id, body.providerTurnId, body.transcript, ["COLLECTING", "AWAITING_FOLLOWUP"]);
  return context.json({ accepted: true }, 202);
});

api.post("/sessions/:id/complete-round", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const session = await getSession(context.env.DB, id);
  if (session.state !== "COLLECTING") {
    throw new ApiError(409, "INVALID_STATE", "The session is not collecting turns.");
  }
  await assertNoKnownPetConflict(context.env.DB, id);
  await reserveProviderInvocation(context.env.DB, id, "llm", hackathonMode(context.env));
  await transitionSession(context.env.DB, id, "ANALYZING");
  await context.env.DB.prepare(
    "UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ? WHERE session_id = ? AND status = 'OPEN'",
  )
    .bind(new Date().toISOString(), id)
    .run();
  return context.json(await completeAnalysisRecovering(context.env, id, "COLLECTING", { hasFollowUpAnswer: false }));
});

api.post("/sessions/:id/reply", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, replyRequestSchema);
  const session = await getSession(context.env.DB, id);
  if (session.state !== "AWAITING_FOLLOWUP") {
    throw new ApiError(409, "INVALID_STATE", "The session is not awaiting a follow-up response.");
  }
  await assertNoKnownPetConflict(context.env.DB, id, body.transcript);
  const pendingCorrection = await getCorrection(context.env.DB, id);
  await reserveProviderInvocation(context.env.DB, id, "llm", hackathonMode(context.env));
  if (pendingCorrection) {
    return context.json(await finishCorrectionAnalysis(context.env, id, pendingCorrection, async () => {
      await context.env.DB.prepare("UPDATE correction_requests SET status = 'PROCESSING', result_json = NULL WHERE session_id = ? AND provider_turn_id = ? AND status = 'AWAITING_FOLLOWUP'")
        .bind(id, pendingCorrection.provider_turn_id).run();
      await transitionSession(context.env.DB, id, "COLLECTING");
      await insertTextTurn(context.env.DB, id, body.providerTurnId, body.transcript);
      const answer = await context.env.DB.prepare("SELECT stt_round_id AS roundId FROM transcript_turns WHERE session_id = ? AND provider_turn_id = ?")
        .bind(id, body.providerTurnId).first<{ roundId: string }>();
      pendingCorrection.last_round_id = answer?.roundId ?? null;
      await context.env.DB.prepare("UPDATE correction_requests SET last_round_id = ? WHERE session_id = ? AND provider_turn_id = ?")
        .bind(pendingCorrection.last_round_id, id, pendingCorrection.provider_turn_id).run();
      await transitionSession(context.env.DB, id, "ANALYZING");
      await context.env.DB.prepare(
        "UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ? WHERE session_id = ? AND status = 'OPEN'",
      )
        .bind(new Date().toISOString(), id)
        .run();
    }));
  }
  await transitionSession(context.env.DB, id, "COLLECTING");
  await insertTextTurn(context.env.DB, id, body.providerTurnId, body.transcript);
  await transitionSession(context.env.DB, id, "ANALYZING");
  await context.env.DB.prepare(
    "UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ? WHERE session_id = ? AND status = 'OPEN'",
  )
    .bind(new Date().toISOString(), id)
    .run();
  return context.json(await completeAnalysisRecovering(context.env, id, "AWAITING_FOLLOWUP", { hasFollowUpAnswer: true }));
});

api.post("/sessions/:id/complete-follow-up-round", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, completedFollowUpRoundSchema);
  const answered = await context.env.DB.prepare("SELECT * FROM correction_requests WHERE session_id = ? AND last_round_id = ?")
    .bind(id, body.roundId).first<CorrectionRequest>();
  if (answered) return context.json(replayCorrection(answered, answered.instruction));
  const session = await getSession(context.env.DB, id);
  if (session.state !== "AWAITING_FOLLOWUP") {
    throw new ApiError(409, "INVALID_STATE", "The session is not awaiting a follow-up response.");
  }
  const latestQuestion = await context.env.DB.prepare(
    "SELECT payload_json AS payloadJson FROM session_events WHERE session_id = ? AND event_type = 'FOLLOW_UP_ASKED' ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).bind(id).first<{ payloadJson: string }>();
  const marker = latestQuestion ? JSON.parse(latestQuestion.payloadJson) as { afterRoundNumber?: unknown } : null;
  const round = await context.env.DB.prepare(
    `SELECT r.round_number AS roundNumber, r.status, COUNT(t.id) AS turnCount
     FROM stt_rounds r LEFT JOIN transcript_turns t ON t.stt_round_id = r.id
     WHERE r.id = ? AND r.session_id = ? GROUP BY r.id`,
  ).bind(body.roundId, id).first<{ roundNumber: number; status: string; turnCount: number }>();
  if (!round || round.status !== "COMPLETED" || round.turnCount < 1 ||
      typeof marker?.afterRoundNumber !== "number" || round.roundNumber <= marker.afterRoundNumber) {
    throw new ApiError(409, "FOLLOW_UP_ROUND_REQUIRED", "A completed new follow-up transcription round is required.");
  }
  await assertNoKnownPetConflict(context.env.DB, id);
  const pendingCorrection = await getCorrection(context.env.DB, id);
  await reserveProviderInvocation(context.env.DB, id, "llm", hackathonMode(context.env));
  if (pendingCorrection) {
    // Claim the answer and business state together before any provider invocation.
    const claimed = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE correction_requests SET status = 'PROCESSING', result_json = NULL, last_round_id = ? WHERE session_id = ? AND provider_turn_id = ? AND status = 'AWAITING_FOLLOWUP'")
        .bind(body.roundId, id, pendingCorrection.provider_turn_id),
      context.env.DB.prepare(`UPDATE sessions SET state = 'ANALYZING', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND state = 'AWAITING_FOLLOWUP' AND EXISTS (SELECT 1 FROM correction_requests
        WHERE session_id = ? AND provider_turn_id = ? AND last_round_id = ? AND status = 'PROCESSING')`)
        .bind(id, id, pendingCorrection.provider_turn_id, body.roundId),
    ]);
    if (claimed[0].meta.changes !== 1 || claimed[1].meta.changes !== 1) throw new ApiError(409, "CORRECTION_IN_PROGRESS", "The correction answer is already being processed.");
    return context.json(await finishCorrectionAnalysis(context.env, id, { ...pendingCorrection, last_round_id: body.roundId }));
  }
  await transitionSession(context.env.DB, id, "COLLECTING");
  await transitionSession(context.env.DB, id, "ANALYZING");
  return context.json(await completeAnalysisRecovering(context.env, id, "AWAITING_FOLLOWUP", { hasFollowUpAnswer: true }));
});

async function finishCorrectionAnalysis(env: Bindings, id: string, request: CorrectionRequest, prepare?: () => Promise<void>) {
  try {
    await prepare?.();
    return await completeAnalysis(env, id, correctionOptions(request));
  } catch (error) {
    console.warn("Correction failed.", { sessionId: id, revision: request.base_revision,
      stage: error instanceof AnalysisUnavailableError ? error.failureStage : "business",
      errorName: error instanceof Error ? error.name : "UnknownError",
      stack: error instanceof Error ? error.stack?.split("\n").filter(line => line.trim().startsWith("at ")).join("\n") : undefined,
      issues: error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path, code: issue.code })) : undefined });
    // The result is persisted in the same transaction as the new draft/question.
    const committed = await getCorrection(env.DB, id, request.provider_turn_id);
    if (committed?.result_json && committed.status !== "PROCESSING" && committed.status !== "FAILED") {
      return replayCorrection(committed, request.instruction);
    }
    const restored = await recoverCorrection(env.DB, request);
    if (!restored) throw new ApiError(503, "CORRECTION_RECOVERY_UNCONFIRMED", "The correction state could not be restored. Reload the session before continuing.");
    if (error instanceof AnalysisUnavailableError) throw providerFailure(error, "ANALYSIS_UNAVAILABLE",
      "The correction could not be interpreted safely. Review the unchanged draft and try again.", hackathonMode(env));
    throw new ApiError(503, "CORRECTION_UNAVAILABLE", "The correction was not applied. Review the unchanged draft and try again.");
  }
}

api.post("/sessions/:id/correct", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, correctionRequestSchema);
  const existing = await getCorrection(context.env.DB, id, body.providerTurnId);
  if (existing) return context.json(replayCorrection(existing, body.transcript));
  const session = await getSession(context.env.DB, id);
  if (session.state !== "AWAITING_APPROVAL" || session.currentDraftRevision < 1) {
    throw new ApiError(409, "INVALID_STATE", "The session is not awaiting a correction.");
  }
  assertCorrectionAvailable(session.currentDraftRevision, hackathonMode(context.env));
  const draft = await context.env.DB.prepare(
    "SELECT content_json AS contentJson FROM note_drafts WHERE session_id = ? AND revision = ?",
  ).bind(id, session.currentDraftRevision).first<{ contentJson: string }>();
  if (!draft) throw new ApiError(409, "DRAFT_NOT_FOUND", "The current draft is missing.");
  deserializeHandoverContent(draft.contentJson);
  await reserveProviderInvocation(context.env.DB, id, "llm", hackathonMode(context.env));
  // Claim once before calling the provider; concurrent/replayed requests cannot create another revision.
  try {
    const claimed = await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO correction_requests (session_id, provider_turn_id, instruction, base_revision, draft_json, status)
        SELECT id, ?, ?, current_draft_revision, ?, 'PROCESSING' FROM sessions WHERE id = ? AND state = 'AWAITING_APPROVAL' AND current_draft_revision = ?`)
        .bind(body.providerTurnId, body.transcript, draft.contentJson, id, session.currentDraftRevision),
      context.env.DB.prepare(`UPDATE sessions SET state = 'CORRECTING', reviewed_revision = NULL, approved_revision = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND state = 'AWAITING_APPROVAL'
        AND EXISTS (SELECT 1 FROM correction_requests WHERE session_id = ? AND provider_turn_id = ? AND status = 'PROCESSING')`)
        .bind(id, id, body.providerTurnId),
    ]);
    if (claimed[0].meta.changes !== 1 || claimed[1].meta.changes !== 1) throw new Error("Correction claim failed.");
  } catch {
    const duplicate = await getCorrection(context.env.DB, id, body.providerTurnId);
    if (duplicate) return context.json(replayCorrection(duplicate, body.transcript));
    throw new ApiError(409, "CORRECTION_IN_PROGRESS", "Another correction is already being processed.");
  }
  const request = (await getCorrection(context.env.DB, id, body.providerTurnId))!;
  return context.json(await finishCorrectionAnalysis(context.env, id, request, async () => {
    await insertTextTurn(context.env.DB, id, body.providerTurnId, body.transcript, ["CORRECTING"]);
    await context.env.DB.prepare("UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ? WHERE session_id = ? AND status = 'OPEN'")
      .bind(new Date().toISOString(), id).run();
  }));
});

api.post("/sessions/:id/review", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const session = await reviewCurrentDraft(context.env.DB, id);
  const draft = await context.env.DB.prepare(
    `SELECT content_json AS contentJson, spoken_summary AS spokenSummary
     FROM note_drafts WHERE session_id = ? AND revision = ?`,
  )
    .bind(id, session.currentDraftRevision)
    .first<{ contentJson: string; spokenSummary: string }>();
  if (!draft) throw new ApiError(409, "DRAFT_NOT_FOUND", "The current draft is missing.");
  return context.json({
    revision: session.currentDraftRevision,
    content: deserializeHandoverContent(draft.contentJson),
    spokenSummary: draft.spokenSummary,
  });
});

api.post("/sessions/:id/approve", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, approveRequestSchema);
  const session = await getSession(context.env.DB, id);
  if (session.state !== "COMPLETED" && (session.state !== "AWAITING_APPROVAL" ||
      session.reviewedRevision !== session.currentDraftRevision || body.revision !== session.currentDraftRevision)) {
    throw new ApiError(409, "APPROVAL_REVISION_REQUIRED", "Review and approve the current draft revision before saving.");
  }
  const note = await approveAndSave(context.env.DB, {
    sessionId: id,
    requestedRevision: body.revision,
    noteId: crypto.randomUUID(),
  });
  return context.json({ state: "COMPLETED", noteId: note.id });
});

api.post("/sessions/:id/cancel", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  return context.json(await cancelSession(context.env.DB, id));
});

api.post("/sessions/:id/stt-token", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const provider =
    context.env.STT_TOKEN_MODE === "fake"
      ? new FakeTokenProvider()
      : context.env.STT_TOKEN_MODE === "fake-error"
        ? new FailingTokenProvider()
        : new AssemblyAITokenProvider(context.env.ASSEMBLYAI_API_KEY ?? "");
  const sessionIssuanceLimit = hackathonMode(context.env) ? HACKATHON_USAGE_LIMIT : resolveSessionSttTokenIssuanceLimit(
    context.env.APP_ENV,
    context.env.DEV_STT_SESSION_TOKEN_ISSUANCE_LIMIT,
  );
  const dailyIssuanceLimit = hackathonMode(context.env) ? HACKATHON_USAGE_LIMIT : resolveDailySttTokenIssuanceLimit(
    context.env.APP_ENV,
    context.env.DEV_STT_DAILY_TOKEN_ISSUANCE_LIMIT,
  );
  return context.json(await issueSttToken(context.env.DB, id, provider, sessionIssuanceLimit, dailyIssuanceLimit));
});

api.post("/sessions/:id/stt-rounds/:roundId/close", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const parsedRoundId = identifierSchema.safeParse(context.req.param("roundId"));
  if (!parsedRoundId.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "The transcription round ID is invalid.");
  }
  return context.json(await abandonSttRound(context.env.DB, id, parsedRoundId.data));
});

api.post("/sessions/:id/stt-rounds/:roundId/complete", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const parsedRoundId = identifierSchema.safeParse(context.req.param("roundId"));
  if (!parsedRoundId.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "The transcription round ID is invalid.");
  }
  return context.json(await completeSttConnection(context.env.DB, id, parsedRoundId.data));
});

api.post("/sessions/:id/speech", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, speechRequestSchema);
  const text = await resolveAuthorizedUtterance(context.env.DB, id, body.utterance);
  await reserveSpeechRequest(context.env.DB, id, body, hackathonMode(context.env));
  try {
    if (context.env.TTS_MODE === "fake-error") {
      throw new Error("Deterministic TTS provider failure.");
    }
    const audio = context.env.TTS_MODE === "fake"
      ? { bytes: fakeMp3(), contentType: MP3_CONTENT_TYPE }
      : context.env.TTS_MODE === "fake-wav"
      ? { bytes: fakeWav(), contentType: WAV_CONTENT_TYPE }
      : await new WorkersAITts(
          context.env.AI as unknown as import("../audio/tts").TtsRunner,
          hackathonMode(context.env),
        ).synthesize(text);
    return new Response(audio.bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "Content-Type": audio.contentType,
        "X-GroomNote-Utterance": body.utterance,
      },
    });
  } catch (error) {
    console.warn("Workers AI speech failed.", safeAnalysisFailureDiagnostics(new AnalysisUnavailableError(error)));
    await releaseSpeechRequest(context.env.DB, id, body.requestId);
    throw providerFailure(new AnalysisUnavailableError(error), "TTS_UNAVAILABLE", "Speech generation is temporarily unavailable.", hackathonMode(context.env));
  }
});

api.get("/notes/:id", async (context) => {
  const parsedNoteId = identifierSchema.safeParse(context.req.param("id"));
  const parsedSessionId = identifierSchema.safeParse(context.req.query("sessionId"));
  if (!parsedNoteId.success || !parsedSessionId.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "The note or session ID is invalid.");
  }
  const noteId = parsedNoteId.data;
  const validSessionId = parsedSessionId.data;
  await requireSessionCredential(context.env.DB, context.req.raw, validSessionId);
  const row = await context.env.DB.prepare(
    `SELECT id, session_id AS sessionId, draft_revision AS revision, content_json AS contentJson
     FROM handover_notes WHERE id = ? AND session_id = ?`,
  )
    .bind(noteId, validSessionId)
    .first<{ id: string; sessionId: string; revision: number; contentJson: string }>();
  if (!row) throw new ApiError(404, "NOTE_NOT_FOUND", "Handover note not found.");
  return context.json({
    id: row.id,
    sessionId: row.sessionId,
    revision: row.revision,
    content: deserializeHandoverContent(row.contentJson),
  });
});

export { api };
