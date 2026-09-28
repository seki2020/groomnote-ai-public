export const BUSINESS_SESSION_DURATION_MS = 12 * 60 * 1_000;

export async function cleanupExpiredSessions(db: D1Database): Promise<number> {
  const results = await db.batch([
    db.prepare(
      `UPDATE sessions SET state = 'EXPIRED',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED')`,
    ),
    db.prepare(
      `UPDATE stt_rounds SET status = 'CANCELLED',
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'OPEN' AND session_id IN (
         SELECT id FROM sessions WHERE state = 'EXPIRED'
       )`,
    ),
  ]);
  return results[0].meta.changes ?? 0;
}
