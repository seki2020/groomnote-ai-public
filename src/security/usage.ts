import { ApiError } from "../api/errors";

export const MAX_LLM_CALLS_PER_SESSION = 5;
export const MAX_TTS_CALLS_PER_SESSION = 8;
export const MAX_DAILY_LLM_CALLS = 100;
export const MAX_DAILY_TTS_CALLS = 200;
export const MAX_FOLLOW_UP_QUESTIONS = 2;
export const MAX_CORRECTION_CYCLES = 2;

// Owner decision: Hackathon deployments permanently bypass application quotas by
// default, including production. Only explicitly setting HACKATHON_MODE="false"
// restores enforcement. Keep the switch and usage accounting for future use.
export function hackathonMode(env: { HACKATHON_MODE?: string }): boolean {
  return env.HACKATHON_MODE !== "false";
}
export const HACKATHON_USAGE_LIMIT = Number.MAX_SAFE_INTEGER;

type ProviderKind = "llm" | "tts";

const columnByKind = {
  llm: "llm_calls",
  tts: "tts_calls",
} as const;

const sessionLimitByKind = {
  llm: MAX_LLM_CALLS_PER_SESSION,
  tts: MAX_TTS_CALLS_PER_SESSION,
} as const;

const dailyLimitByKind = {
  llm: MAX_DAILY_LLM_CALLS,
  tts: MAX_DAILY_TTS_CALLS,
} as const;

export async function reserveProviderInvocation(
  db: D1Database,
  sessionId: string,
  kind: ProviderKind,
  relaxed = false,
): Promise<void> {
  const column = columnByKind[kind];
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO usage_quotas (id, session_id, quota_date)
       VALUES (?, ?, date('now'))`,
    ).bind(crypto.randomUUID(), sessionId),
    db.prepare(
      `INSERT OR IGNORE INTO daily_provider_usage (quota_date)
       VALUES (date('now'))`,
    ),
  ]);

  const sessionReservation = await db.prepare(
    `UPDATE usage_quotas SET ${column} = ${column} + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE session_id = ? AND ${column} < ?`,
  ).bind(sessionId, (relaxed ? HACKATHON_USAGE_LIMIT : sessionLimitByKind[kind])).run();
  if (sessionReservation.meta.changes !== 1) {
    throw new ApiError(kind === "tts" ? 409 : 429, `${kind.toUpperCase()}_QUOTA_EXCEEDED`,
      `The session ${kind.toUpperCase()} quota is exhausted.`);
  }

  const dailyReservation = await db.prepare(
    `UPDATE daily_provider_usage SET ${column} = ${column} + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE quota_date = date('now') AND ${column} < ?`,
  ).bind((relaxed ? HACKATHON_USAGE_LIMIT : dailyLimitByKind[kind])).run();
  if (dailyReservation.meta.changes !== 1) {
    await db.prepare(
      `UPDATE usage_quotas SET ${column} = ${column} - 1
       WHERE session_id = ? AND ${column} > 0`,
    ).bind(sessionId).run();
    throw new ApiError(429, `${kind.toUpperCase()}_DAILY_QUOTA_EXCEEDED`,
      `The daily ${kind.toUpperCase()} quota is exhausted.`);
  }
}

export async function assertFollowUpAvailable(db: D1Database, sessionId: string, relaxed = false): Promise<void> {
  if (relaxed) return;
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM session_events
     WHERE session_id = ? AND event_type = 'FOLLOW_UP_ASKED'`,
  ).bind(sessionId).first<{ count: number }>();
  if ((count?.count ?? 0) >= MAX_FOLLOW_UP_QUESTIONS) {
    throw new ApiError(429, "FOLLOW_UP_QUOTA_EXCEEDED", "The follow-up question limit is exhausted.");
  }
}

export function assertCorrectionAvailable(currentDraftRevision: number, relaxed = false): void {
  if (relaxed) return;
  if (currentDraftRevision >= 1 + MAX_CORRECTION_CYCLES) {
    throw new ApiError(429, "CORRECTION_QUOTA_EXCEEDED", "The correction cycle limit is exhausted.");
  }
}
