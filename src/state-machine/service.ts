import { z } from "zod";

import {
  getHandoverNoteForSession,
  saveHandoverNote,
  type HandoverNoteRecord,
} from "../persistence/repository";
import {
  handoverContentSchema,
  identifierSchema,
  serializeHandoverContent,
  type HandoverContent,
} from "../persistence/schemas";
import {
  assertApprovalEligible,
  isTransitionAllowed,
  sessionStates,
  type SessionSnapshot,
  type SessionState,
} from "./model";

const sessionStateSchema = z.enum(sessionStates);

type SessionRow = {
  id: string;
  appointmentId: string | null;
  state: string;
  currentDraftRevision: number;
  reviewedRevision: number | null;
  approvedRevision: number | null;
  expiresAt: string;
};

export type StoredSession = Omit<SessionRow, "state"> & { state: SessionState };

export async function getSession(db: D1Database, id: string): Promise<StoredSession> {
  const sessionId = identifierSchema.parse(id);
  const row = await db
    .prepare(
      `SELECT id, appointment_id AS appointmentId, state,
              current_draft_revision AS currentDraftRevision,
              reviewed_revision AS reviewedRevision,
              approved_revision AS approvedRevision,
              expires_at AS expiresAt
       FROM sessions WHERE id = ?`,
    )
    .bind(sessionId)
    .first<SessionRow>();
  if (!row) throw new Error("Session not found.");
  return { ...row, state: sessionStateSchema.parse(row.state) };
}

function snapshot(session: StoredSession): SessionSnapshot {
  return {
    state: session.state,
    currentDraftRevision: session.currentDraftRevision,
    reviewedRevision: session.reviewedRevision,
    approvedRevision: session.approvedRevision,
  };
}

export async function transitionSession(
  db: D1Database,
  sessionId: string,
  to: SessionState,
): Promise<StoredSession> {
  const current = await getSession(db, sessionId);
  if (!isTransitionAllowed(current.state, to)) {
    throw new Error(`Invalid session transition: ${current.state} -> ${to}.`);
  }
  const result = await db
    .prepare(
      `UPDATE sessions SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND state = ?`,
    )
    .bind(to, current.id, current.state)
    .run();
  if (result.meta.changes !== 1) throw new Error("Concurrent session transition detected.");
  return getSession(db, current.id);
}

export async function createDraft(
  db: D1Database,
  input: {
    id: string;
    sessionId: string;
    content: HandoverContent;
    spokenSummary: string;
  },
): Promise<number> {
  const id = identifierSchema.parse(input.id);
  const session = await getSession(db, input.sessionId);
  if (!(["ANALYZING", "AWAITING_FOLLOWUP", "CORRECTING"] as SessionState[]).includes(session.state)) {
    throw new Error("Session cannot create a draft in its current state.");
  }
  const content = handoverContentSchema.parse(input.content);
  const spokenSummary = input.spokenSummary.trim();
  if (!spokenSummary) throw new Error("Spoken summary is required.");
  const revision = session.currentDraftRevision + 1;

  const results = await db.batch([
    db
      .prepare(
        `UPDATE sessions
         SET state = 'REVIEWING', current_draft_revision = ?, reviewed_revision = NULL,
             approved_revision = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = ? AND current_draft_revision = ?`,
      )
      .bind(revision, session.id, session.state, session.currentDraftRevision),
    db
      .prepare(
        `INSERT INTO note_drafts (id, session_id, revision, content_json, spoken_summary)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM sessions
           WHERE id = ? AND state = 'REVIEWING' AND current_draft_revision = ?
         )`,
      )
      .bind(
        id,
        session.id,
        revision,
        serializeHandoverContent(content),
        spokenSummary,
        session.id,
        revision,
      ),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new Error("Concurrent draft revision detected.");
  }
  return revision;
}

export async function reviewCurrentDraft(
  db: D1Database,
  sessionId: string,
): Promise<StoredSession> {
  const session = await getSession(db, sessionId);
  if (session.state !== "REVIEWING" || session.currentDraftRevision < 1) {
    throw new Error("No current draft is ready for review.");
  }
  const result = await db
    .prepare(
      `UPDATE sessions
       SET state = 'AWAITING_APPROVAL', reviewed_revision = current_draft_revision,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND state = 'REVIEWING' AND current_draft_revision = ?`,
    )
    .bind(session.id, session.currentDraftRevision)
    .run();
  if (result.meta.changes !== 1) throw new Error("Concurrent review detected.");
  return getSession(db, session.id);
}

export async function beginCorrection(
  db: D1Database,
  sessionId: string,
): Promise<StoredSession> {
  const session = await getSession(db, sessionId);
  if (session.state !== "AWAITING_APPROVAL") {
    throw new Error("Session is not awaiting approval.");
  }
  const result = await db
    .prepare(
      `UPDATE sessions
       SET state = 'CORRECTING', reviewed_revision = NULL, approved_revision = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND state = 'AWAITING_APPROVAL'`,
    )
    .bind(session.id)
    .run();
  if (result.meta.changes !== 1) throw new Error("Concurrent correction detected.");
  return getSession(db, session.id);
}

export async function cancelSession(db: D1Database, sessionId: string): Promise<StoredSession> {
  const session = await getSession(db, sessionId);
  if (!isTransitionAllowed(session.state, "CANCELLED")) {
    throw new Error("Session cannot be cancelled from its current state.");
  }
  return transitionSession(db, session.id, "CANCELLED");
}

export async function expireSessionIfDue(
  db: D1Database,
  sessionId: string,
  now: Date,
): Promise<StoredSession> {
  const session = await getSession(db, sessionId);
  if (new Date(session.expiresAt).getTime() > now.getTime()) return session;
  if (!isTransitionAllowed(session.state, "EXPIRED")) return session;
  return transitionSession(db, session.id, "EXPIRED");
}

export async function approveAndSave(
  db: D1Database,
  input: { sessionId: string; requestedRevision: number; noteId: string },
): Promise<HandoverNoteRecord> {
  let session = await getSession(db, input.sessionId);
  if (session.state === "COMPLETED") {
    const existing = await getHandoverNoteForSession(db, session.id);
    if (!existing) throw new Error("Completed session has no persisted note.");
    return existing;
  }
  assertApprovalEligible(snapshot(session), input.requestedRevision);
  if (!session.appointmentId) throw new Error("Session identity is unresolved.");

  const claim = await db
    .prepare(
      `UPDATE sessions SET state = 'SAVING', approved_revision = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND state = 'AWAITING_APPROVAL'
         AND current_draft_revision = ? AND reviewed_revision = ?`,
    )
    .bind(input.requestedRevision, session.id, input.requestedRevision, input.requestedRevision)
    .run();
  if (claim.meta.changes !== 1) {
    session = await getSession(db, session.id);
    if (session.state === "COMPLETED") {
      const existing = await getHandoverNoteForSession(db, session.id);
      if (existing) return existing;
    }
    throw new Error("Another completion request owns this session.");
  }

  try {
    const draft = await db
      .prepare(
        `SELECT content_json AS contentJson FROM note_drafts
         WHERE session_id = ? AND revision = ?`,
      )
      .bind(session.id, input.requestedRevision)
      .first<{ contentJson: string }>();
    const appointment = await db
      .prepare("SELECT pet_id AS petId FROM appointments WHERE id = ?")
      .bind(session.appointmentId)
      .first<{ petId: string }>();
    if (!draft || !appointment) throw new Error("Approved draft identity data is missing.");

    const note = await saveHandoverNote(db, {
      id: input.noteId,
      sessionId: session.id,
      appointmentId: session.appointmentId,
      petId: appointment.petId,
      draftRevision: input.requestedRevision,
      content: handoverContentSchema.parse(JSON.parse(draft.contentJson)),
    });
    const completed = await db
      .prepare(
        `UPDATE sessions SET state = 'COMPLETED',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'SAVING' AND approved_revision = ?`,
      )
      .bind(session.id, input.requestedRevision)
      .run();
    if (completed.meta.changes !== 1) throw new Error("Session completion lost state ownership.");
    return note;
  } catch (error) {
    await db
      .prepare(
        `UPDATE sessions SET state = 'FAILED',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'SAVING'`,
      )
      .bind(session.id)
      .run();
    throw error;
  }
}
