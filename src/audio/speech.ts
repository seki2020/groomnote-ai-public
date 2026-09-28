import { z } from "zod";
import { ApiError } from "../api/errors";
import { getSession } from "../state-machine/service";

export const MAX_TTS_CALLS_PER_SESSION = 20;
export const speechKinds = ["opening", "follow_up", "summary", "save_confirmation"] as const;
export const speechRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  utterance: z.enum(speechKinds),
}).strict();
export type SpeechRequest = z.infer<typeof speechRequestSchema>;

export async function resolveAuthorizedUtterance(
  db: D1Database,
  sessionId: string,
  utterance: SpeechRequest["utterance"],
): Promise<string> {
  const session = await getSession(db, sessionId);
  if (utterance === "opening") {
    const pet = await db.prepare(
      `SELECT p.name FROM sessions s JOIN appointments a ON a.id = s.appointment_id
       JOIN pets p ON p.id = a.pet_id WHERE s.id = ?`,
    ).bind(sessionId).first<{ name: string }>();
    if (!pet) throw new ApiError(409, "UTTERANCE_UNAVAILABLE", "The opening prompt is unavailable.");
    return "PUBLIC_SPEECH_COPY_PLACEHOLDER";
  }
  if (utterance === "follow_up") {
    const event = await db.prepare(
      `SELECT payload_json AS payloadJson FROM session_events
       WHERE session_id = ? AND event_type = 'FOLLOW_UP_ASKED'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(sessionId).first<{ payloadJson: string }>();
    if (!event) throw new ApiError(409, "UTTERANCE_UNAVAILABLE", "No follow-up is available.");
    return z.object({ question: z.string().min(1) }).parse(JSON.parse(event.payloadJson)).question;
  }
  if (utterance === "summary") {
    const draft = await db.prepare(
      `SELECT spoken_summary AS spokenSummary FROM note_drafts
       WHERE session_id = ? AND revision = ?`,
    ).bind(sessionId, session.currentDraftRevision).first<{ spokenSummary: string }>();
    if (!draft) throw new ApiError(409, "UTTERANCE_UNAVAILABLE", "No spoken summary is available.");
    return draft.spokenSummary;
  }
  if (session.state !== "COMPLETED") {
    throw new ApiError(409, "UTTERANCE_UNAVAILABLE", "The save confirmation is unavailable.");
  }
  return "PUBLIC_SPEECH_COPY_PLACEHOLDER";
}

export async function reserveSpeechRequest(
  db: D1Database,
  sessionId: string,
  request: SpeechRequest,
): Promise<void> {
  const duplicate = await db.prepare(
    "SELECT 1 AS found FROM speech_requests WHERE session_id = ? AND id = ?",
  ).bind(sessionId, request.requestId).first();
  if (duplicate) throw new ApiError(409, "DUPLICATE_SPEECH_REQUEST", "This speech request was already used.");
  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM speech_requests WHERE session_id = ?",
  ).bind(sessionId).first<{ count: number }>();
  if ((count?.count ?? 0) >= MAX_TTS_CALLS_PER_SESSION) {
    throw new ApiError(409, "TTS_QUOTA_EXCEEDED", "The session speech quota is exhausted.");
  }
  try {
    await db.prepare(
      "INSERT INTO speech_requests (id, session_id, utterance_type) VALUES (?, ?, ?)",
    ).bind(request.requestId, sessionId, request.utterance).run();
  } catch {
    throw new ApiError(409, "DUPLICATE_SPEECH_REQUEST", "This speech request was already used.");
  }
}

export async function releaseSpeechRequest(
  db: D1Database,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await db.prepare("DELETE FROM speech_requests WHERE session_id = ? AND id = ?")
    .bind(sessionId, requestId).run();
}
