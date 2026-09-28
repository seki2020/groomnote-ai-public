import { Hono } from "hono";
import { z } from "zod";
import { analyzeDeterministically } from "../analysis/fake-llm";
import { deserializeHandoverContent, identifierSchema } from "../persistence/schemas";
import {
  approveAndSave,
  cancelSession,
  createDraft,
  getSession,
  reviewCurrentDraft,
  transitionSession,
} from "../state-machine/service";
import type { Bindings } from "../types";
import { hashCredential, requireDemoCredential, requireSessionCredential } from "./auth";
import { ApiError } from "./errors";
import {
  addTurnRequestSchema,
  approveRequestSchema,
  createSessionRequestSchema,
  replyRequestSchema,
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
    value = await request.json();
  } catch {
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
): Promise<void> {
  if ((await getSession(db, sessionId)).state !== "COLLECTING") {
    throw new ApiError(409, "INVALID_STATE", "The session is not collecting turns.");
  }
  const roundId = await ensureRound(db, sessionId);
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

async function analyzeSession(db: D1Database, sessionId: string, hasFollowUpAnswer: boolean) {
  const identity = await db
    .prepare(
      `SELECT p.name AS petName FROM sessions s
       JOIN appointments a ON a.id = s.appointment_id
       JOIN pets p ON p.id = a.pet_id WHERE s.id = ?`,
    )
    .bind(sessionId)
    .first<{ petName: string }>();
  const turns = await db
    .prepare("SELECT transcript FROM transcript_turns WHERE session_id = ? ORDER BY created_at, id")
    .bind(sessionId)
    .all<{ transcript: string }>();
  if (!identity || turns.results.length === 0) {
    throw new ApiError(409, "INSUFFICIENT_INPUT", "At least one transcript turn is required.");
  }
  return analyzeDeterministically({
    petName: identity.petName,
    transcripts: turns.results.map((turn) => turn.transcript),
    hasFollowUpAnswer,
  });
}

async function completeAnalysis(db: D1Database, sessionId: string, hasFollowUpAnswer: boolean) {
  const analysis = await analyzeSession(db, sessionId, hasFollowUpAnswer);
  if (analysis.kind === "follow_up") {
    await transitionSession(db, sessionId, "AWAITING_FOLLOWUP");
    return { action: "follow_up" as const, question: analysis.question };
  }
  const revision = await createDraft(db, {
    id: crypto.randomUUID(),
    sessionId,
    content: analysis.content,
    spokenSummary: analysis.spokenSummary,
  });
  return { action: "review" as const, revision };
}

api.post("/sessions", async (context) => {
  await requireDemoCredential(context.req.raw, context.env.DEMO_API_KEY);
  const body = await parseJson(context.req.raw, createSessionRequestSchema);
  const appointment = await context.env.DB.prepare(
    `SELECT a.id, p.name AS petName FROM appointments a
     JOIN pets p ON p.id = a.pet_id WHERE a.id = ?`,
  )
    .bind(body.appointmentId)
    .first<{ id: string; petName: string }>();
  if (!appointment) throw new ApiError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found.");

  const id = crypto.randomUUID();
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  await context.env.DB.prepare(
    `INSERT INTO sessions (id, appointment_id, state, expires_at, session_token_hash)
     VALUES (?, ?, 'CREATED', ?, ?)`,
  )
    .bind(
      id,
      body.appointmentId,
      new Date(Date.now() + 12 * 60 * 1_000).toISOString(),
      await hashCredential(token),
    )
    .run();
  await transitionSession(context.env.DB, id, "OPENING");
  await transitionSession(context.env.DB, id, "COLLECTING");
  return context.json(
    {
      id,
      sessionToken: token,
      state: "COLLECTING",
      openingPrompt: "PUBLIC_OPENING_COPY_PLACEHOLDER",
    },
    201,
  );
});

api.get("/sessions/:id", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  return context.json(await getSession(context.env.DB, id));
});

api.post("/sessions/:id/turns", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, addTurnRequestSchema);
  await insertTextTurn(context.env.DB, id, body.providerTurnId, body.transcript);
  return context.json({ accepted: true }, 202);
});

api.post("/sessions/:id/complete-round", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  await transitionSession(context.env.DB, id, "ANALYZING");
  await context.env.DB.prepare(
    "UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ? WHERE session_id = ? AND status = 'OPEN'",
  )
    .bind(new Date().toISOString(), id)
    .run();
  return context.json(await completeAnalysis(context.env.DB, id, false));
});

api.post("/sessions/:id/reply", async (context) => {
  const id = sessionIdFrom(context);
  await requireSessionCredential(context.env.DB, context.req.raw, id);
  const body = await parseJson(context.req.raw, replyRequestSchema);
  await transitionSession(context.env.DB, id, "COLLECTING");
  await insertTextTurn(context.env.DB, id, body.providerTurnId, body.transcript);
  await transitionSession(context.env.DB, id, "ANALYZING");
  await context.env.DB.prepare(
    "UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ? WHERE session_id = ? AND status = 'OPEN'",
  )
    .bind(new Date().toISOString(), id)
    .run();
  return context.json(await completeAnalysis(context.env.DB, id, true));
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
