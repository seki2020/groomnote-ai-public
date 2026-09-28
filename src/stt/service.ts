import { ApiError } from "../api/errors";
import { getSession } from "../state-machine/service";
import {
  ASSEMBLYAI_WEBSOCKET_ENDPOINT,
  MAX_SESSION_DURATION_SECONDS,
  TOKEN_EXPIRES_IN_SECONDS,
  type TokenProvider,
} from "./assemblyai";

export const MAX_STT_TOKEN_ISSUANCES = 5;
export const MAX_DAILY_STT_TOKEN_ISSUANCES = 50;

async function releaseQuota(db: D1Database, sessionId: string): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE usage_quotas SET stt_token_issuances = stt_token_issuances - 1
       WHERE session_id = ? AND stt_token_issuances > 0`,
    ).bind(sessionId),
    db.prepare(
      `UPDATE daily_stt_usage SET token_issuances = token_issuances - 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE quota_date = date('now') AND token_issuances > 0`,
    ),
  ]);
}

async function reserveRound(db: D1Database, sessionId: string): Promise<string> {
  const session = await getSession(db, sessionId);
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new ApiError(409, "SESSION_EXPIRED", "The session has expired.");
  }
  if (!("COLLECTING AWAITING_FOLLOWUP AWAITING_APPROVAL".split(" ") as string[]).includes(session.state)) {
    throw new ApiError(409, "INVALID_STATE", "The session cannot start transcription now.");
  }

  const quotaId = crypto.randomUUID();
  await db.prepare(
    `INSERT OR IGNORE INTO usage_quotas
       (id, session_id, quota_date, stt_token_issuances)
     VALUES (?, ?, date('now'), 0)`,
  ).bind(quotaId, sessionId).run();
  const quota = await db.prepare(
    `UPDATE usage_quotas SET stt_token_issuances = stt_token_issuances + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE session_id = ? AND stt_token_issuances < ?`,
  ).bind(sessionId, MAX_STT_TOKEN_ISSUANCES).run();
  if (quota.meta.changes !== 1) {
    throw new ApiError(429, "STT_TOKEN_QUOTA_EXCEEDED", "The session token quota is exhausted.");
  }

  await db.prepare(
    `INSERT OR IGNORE INTO daily_stt_usage (quota_date, token_issuances)
     VALUES (date('now'), 0)`,
  ).run();
  const dailyQuota = await db.prepare(
    `UPDATE daily_stt_usage SET token_issuances = token_issuances + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE quota_date = date('now') AND token_issuances < ?`,
  ).bind(MAX_DAILY_STT_TOKEN_ISSUANCES).run();
  if (dailyQuota.meta.changes !== 1) {
    await db.prepare(
      `UPDATE usage_quotas SET stt_token_issuances = stt_token_issuances - 1
       WHERE session_id = ? AND stt_token_issuances > 0`,
    ).bind(sessionId).run();
    throw new ApiError(429, "STT_DAILY_QUOTA_EXCEEDED", "The daily transcription token quota is exhausted.");
  }

  const count = await db.prepare("SELECT COUNT(*) AS count FROM stt_rounds WHERE session_id = ?")
    .bind(sessionId).first<{ count: number }>();
  const roundId = crypto.randomUUID();
  try {
    await db.prepare(
      `INSERT INTO stt_rounds (id, session_id, round_number, status)
       VALUES (?, ?, ?, 'OPEN')`,
    ).bind(roundId, sessionId, (count?.count ?? 0) + 1).run();
  } catch {
    await releaseQuota(db, sessionId);
    throw new ApiError(409, "STT_ROUND_ACTIVE", "A transcription round is already active.");
  }
  return roundId;
}

export async function issueSttToken(
  db: D1Database,
  sessionId: string,
  provider: TokenProvider,
) {
  const roundId = await reserveRound(db, sessionId);
  try {
    const token = await provider.createToken();
    return {
      token,
      roundId,
      expiresInSeconds: TOKEN_EXPIRES_IN_SECONDS,
      maxSessionDurationSeconds: MAX_SESSION_DURATION_SECONDS,
      websocketUrl: ASSEMBLYAI_WEBSOCKET_ENDPOINT,
    };
  } catch (error) {
    console.error(
      "AssemblyAI temporary-token request failed:",
      error instanceof Error ? error.message : "Unknown provider error.",
    );
    await db.prepare("UPDATE stt_rounds SET status = 'FAILED' WHERE id = ? AND status = 'OPEN'")
      .bind(roundId).run();
    await releaseQuota(db, sessionId);
    throw new ApiError(503, "STT_PROVIDER_UNAVAILABLE", "Temporary transcription credentials are unavailable.");
  }
}

export async function abandonSttRound(
  db: D1Database,
  sessionId: string,
  roundId: string,
) {
  const result = await db.prepare(
    `UPDATE stt_rounds SET status = 'FAILED', completed_at = ?
     WHERE id = ? AND session_id = ? AND status = 'OPEN'`,
  ).bind(new Date().toISOString(), roundId, sessionId).run();
  if (result.meta.changes === 1) return { closed: true, status: "FAILED" as const };

  const existing = await db.prepare(
    "SELECT status FROM stt_rounds WHERE id = ? AND session_id = ?",
  ).bind(roundId, sessionId).first<{ status: string }>();
  if (!existing) throw new ApiError(404, "STT_ROUND_NOT_FOUND", "The transcription round was not found.");
  return { closed: false, status: existing.status };
}

export async function completeSttConnection(
  db: D1Database,
  sessionId: string,
  roundId: string,
) {
  const result = await db.prepare(
    `UPDATE stt_rounds SET status = 'COMPLETED', completed_at = ?
     WHERE id = ? AND session_id = ? AND status = 'OPEN'`,
  ).bind(new Date().toISOString(), roundId, sessionId).run();
  if (result.meta.changes === 1) return { closed: true, status: "COMPLETED" as const };
  const existing = await db.prepare(
    "SELECT status FROM stt_rounds WHERE id = ? AND session_id = ?",
  ).bind(roundId, sessionId).first<{ status: string }>();
  if (!existing) throw new ApiError(404, "STT_ROUND_NOT_FOUND", "The transcription round was not found.");
  return { closed: false, status: existing.status };
}
