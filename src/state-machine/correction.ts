import { ApiError } from "../api/errors";
import { deserializeHandoverContent } from "../persistence/schemas";

export type CorrectionRequest = {
  session_id: string; provider_turn_id: string; instruction: string;
  base_revision: number; draft_json: string;
  status: "PROCESSING" | "AWAITING_FOLLOWUP" | "COMPLETED" | "FAILED";
  result_json: string | null; last_round_id: string | null;
};
export async function getCorrection(db: D1Database, sessionId: string, turnId?: string) {
  return db.prepare(turnId === undefined
    ? "SELECT * FROM correction_requests WHERE session_id = ? AND status IN ('PROCESSING', 'AWAITING_FOLLOWUP') LIMIT 1"
    : "SELECT * FROM correction_requests WHERE session_id = ? AND provider_turn_id = ?")
    .bind(...(turnId === undefined ? [sessionId] : [sessionId, turnId])).first<CorrectionRequest>();
}
export function correctionOptions(request: CorrectionRequest) {
  return { hasFollowUpAnswer: true, correctionInstruction: request.instruction,
    currentDraft: deserializeHandoverContent(request.draft_json), correctionRequest: request };
}
export function replayCorrection(request: CorrectionRequest, instruction: string) {
  if (request.instruction !== instruction) throw new ApiError(409, "CORRECTION_REQUEST_CONFLICT", "This correction request ID was used with different text.");
  if (request.result_json && request.status !== "FAILED") return JSON.parse(request.result_json) as { action: "review"; revision: number } | { action: "follow_up"; question: string };
  throw new ApiError(409, request.status === "FAILED" ? "CORRECTION_RETRY_REQUIRED" : "CORRECTION_IN_PROGRESS",
    request.status === "FAILED" ? "Review the unchanged draft and submit a new correction." : "This correction is still being processed.");
}

/** Only restore an uncommitted correction. A committed newer revision must survive. */
export async function recoverCorrection(db: D1Database, request: CorrectionRequest) {
  const results = await db.batch([
    db.prepare(`UPDATE sessions SET state = 'REVIEWING', reviewed_revision = NULL, approved_revision = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND current_draft_revision = ? AND state IN ('CORRECTING', 'COLLECTING', 'ANALYZING', 'AWAITING_FOLLOWUP')`)
      .bind(request.session_id, request.base_revision),
    db.prepare(`DELETE FROM transcript_turns WHERE session_id = ? AND (provider_turn_id = ? OR created_at >=
        (SELECT created_at FROM correction_requests WHERE session_id = ? AND provider_turn_id = ?))
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'REVIEWING' AND current_draft_revision = ?)`)
      .bind(request.session_id, request.provider_turn_id, request.session_id, request.provider_turn_id, request.session_id, request.base_revision),
    db.prepare(`UPDATE correction_requests SET status = 'FAILED', result_json = NULL
      WHERE session_id = ? AND provider_turn_id = ? AND status != 'COMPLETED'
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'REVIEWING' AND current_draft_revision = ?)`)
      .bind(request.session_id, request.provider_turn_id, request.session_id, request.base_revision),
  ]);
  return results[0].meta.changes === 1;
}
