import type { BrowserSession } from "../api";
import type { FinalTurn } from "../stt/transcript";
import { BusinessApiError, sameDraftContent, type BusinessApi, type BusinessState, type ReviewDraft, type SavedNote } from "./api";

export type BusinessPhase = BusinessState | "ERROR" | "CORRECTING" | "SAVING" | "VERIFYING_SAVE" | "SAVE_CONFIRMED_UNVERIFIED";
export interface CompletedTranscriptRound { roundId: string; turns: FinalTurn[] }
export interface BusinessSnapshot {
  phase: BusinessPhase;
  backendState: BusinessState;
  question: string;
  questionIdentity?: string;
  draft: ReviewDraft | null;
  transcriptRounds: CompletedTranscriptRound[];
  error: string;
  noteId: string | null;
  savedNote: SavedNote | null;
  reviewedRevision: number | null;
  saveStatus: "NONE" | "SAVING" | "SAVE_CONFIRMED" | "VERIFIED" | "VERIFICATION_FAILED" | "SAVE_FAILED";
}

export class BusinessController {
  private value: BusinessSnapshot = { phase: "COLLECTING", backendState: "COLLECTING", question: "", draft: null, transcriptRounds: [], error: "", noteId: null, savedNote: null, reviewedRevision: null, saveStatus: "NONE" };
  private busy = false;
  private lastAnalyzedRoundId: string | null = null;
  constructor(private readonly session: BrowserSession, private readonly api: BusinessApi, private readonly notify: (snapshot: BusinessSnapshot) => void) {}
  get snapshot() { return this.value; }
  private update(patch: Partial<BusinessSnapshot>) { this.value = { ...this.value, ...patch }; this.notify(this.value); }
  recordRound(roundId: string, turns: FinalTurn[]) {
    if (this.value.transcriptRounds.some(round => round.roundId === roundId)) return;
    this.update({ transcriptRounds: [...this.value.transcriptRounds, { roundId, turns: [...turns] }] });
  }
  canStartListening() { return !this.busy && ["COLLECTING", "AWAITING_FOLLOWUP"].includes(this.value.backendState) && this.value.phase !== "ANALYZING"; }
  canStartReviewCapture() { return !this.busy && this.value.backendState === "AWAITING_APPROVAL" && this.value.reviewedRevision === this.value.draft?.revision; }
  canAnalyze(roundId: string | null, persisted: number) {
    return !this.busy && persisted > 0 && roundId !== null && roundId !== this.lastAnalyzedRoundId &&
      ["COLLECTING", "AWAITING_FOLLOWUP"].includes(this.value.backendState);
  }
  async analyze(roundId: string | null) {
    if (this.busy || !["COLLECTING", "AWAITING_FOLLOWUP"].includes(this.value.backendState)) return;
    const previous = this.value.backendState;
    if (previous === "AWAITING_FOLLOWUP" && !roundId) { this.update({ phase: "ERROR", error: "A completed answer round is required." }); return; }
    if (roundId && roundId === this.lastAnalyzedRoundId) return;
    this.busy = true;
    this.update({ phase: "ANALYZING", error: "" });
    try {
      const decision = previous === "AWAITING_FOLLOWUP"
        ? await this.api.completeFollowUpRound(this.session, roundId!)
        : await this.api.completeRound(this.session);
      const status = await this.api.getSession(this.session);
      if (decision.action === "follow_up") {
        if (status.state !== "AWAITING_FOLLOWUP") throw new Error("Analysis state does not match the follow-up response.");
        this.update({ phase: status.state, backendState: status.state, question: decision.question,
          questionIdentity: `${roundId ?? "initial"}:${decision.question}`, error: "" });
      } else {
        if (status.state !== "REVIEWING" || status.currentDraftRevision !== decision.revision) throw new Error("Analysis state does not match the review response.");
        await this.loadReview(decision.revision);
      }
      this.lastAnalyzedRoundId = roundId;
    } catch (error) {
      let backendState = previous;
      try { backendState = (await this.api.getSession(this.session)).state; } catch { /* Keep the last confirmed state. */ }
      const detail = error instanceof BusinessApiError ? `${error.code} (${error.status}): ${error.message}` : error instanceof Error ? error.message : "Analysis failed.";
      this.update({ phase: "ERROR", backendState, error: detail });
    } finally { this.busy = false; }
  }
  async resumeReview() {
    if (this.busy || this.value.backendState !== "REVIEWING") return;
    this.busy = true;
    this.update({ phase: "ANALYZING", error: "" });
    try { await this.loadReview(); }
    catch (error) { this.update({ phase: "ERROR", error: error instanceof Error ? error.message : "Review failed." }); }
    finally { this.busy = false; }
  }

  async correct(transcript: string, roundId: string) {
    if (this.busy || !this.canStartReviewCapture() || !transcript.trim()) return this.value;
    const previousDraft = this.value.draft;
    if (!previousDraft) return this.value;
    this.busy = true;
    this.update({ phase: "CORRECTING", error: "" });
    try {
      const decision = await this.api.correct(this.session, `${roundId}:correction`, transcript.trim());
      if (decision.action !== "review" || decision.revision <= previousDraft.revision) throw new Error("Correction did not produce a newer review revision.");
      const status = await this.api.getSession(this.session);
      if (status.state !== "REVIEWING" || status.currentDraftRevision !== decision.revision) throw new Error("Correction revision does not match the Worker session.");
      await this.loadReview(decision.revision);
    } catch (error) {
      const detail = error instanceof BusinessApiError ? `${error.code} (${error.status}): ${error.message}` : error instanceof Error ? error.message : "Correction failed.";
      let current = this.value.backendState;
      try { current = (await this.api.getSession(this.session)).state; } catch { /* Keep last confirmed state. */ }
      if (current === "REVIEWING") {
        try {
          const status = await this.api.getSession(this.session);
          await this.loadReview(status.currentDraftRevision);
        } catch { this.update({ backendState: current }); }
      } else {
        this.update({ backendState: current, phase: current === "AWAITING_APPROVAL" ? current : "ERROR" });
      }
      this.update({ phase: "ERROR", error: `Correction was not applied: ${detail}` });
    } finally { this.busy = false; }
    return this.value;
  }

  async approve() {
    if (this.busy || !this.canStartReviewCapture() || !this.value.draft) return;
    const expected = this.value.draft;
    const revision = expected.revision;
    this.busy = true;
    this.update({ phase: "SAVING", saveStatus: "SAVING", error: "", noteId: null, savedNote: null });
    try {
      let completion: { state: "COMPLETED"; noteId: string };
      try {
        completion = await this.api.approve(this.session, revision);
      } catch (original) {
        const status = await this.api.getSession(this.session);
        if (status.state === "SAVING") throw original;
        if (status.state !== "COMPLETED") throw original;
        // The Worker approval endpoint is idempotent after COMPLETED and returns the existing note ID.
        completion = await this.api.approve(this.session, revision);
      }
      if (completion.state !== "COMPLETED") throw new Error("Worker did not confirm note persistence.");
      this.update({ phase: "VERIFYING_SAVE", backendState: "COMPLETED", noteId: completion.noteId, saveStatus: "SAVE_CONFIRMED", error: "" });
      await this.verifySavedNote(completion.noteId, expected);
    } catch (error) {
      let state = this.value.backendState;
      try { state = (await this.api.getSession(this.session)).state; } catch { /* Preserve the last confirmed Worker state. */ }
      const detail = error instanceof BusinessApiError ? `${error.code} (${error.status}): ${error.message}` : error instanceof Error ? error.message : "Save failed.";
      this.update({ phase: "ERROR", backendState: state, saveStatus: state === "COMPLETED" ? "SAVE_CONFIRMED" : "SAVE_FAILED", error: state === "COMPLETED" ? `Note save was confirmed, but recovery is incomplete: ${detail}` : `Note was not confirmed as saved: ${detail}` });
    } finally { this.busy = false; }
  }

  async retrySavedNoteVerification() {
    if (this.busy || !this.value.noteId || !this.value.draft || this.value.saveStatus !== "VERIFICATION_FAILED") return;
    this.busy = true;
    this.update({ phase: "VERIFYING_SAVE", error: "" });
    try { await this.verifySavedNote(this.value.noteId, this.value.draft); }
    finally { this.busy = false; }
  }

  async cancel() {
    if (this.busy || this.value.backendState !== "AWAITING_APPROVAL") return;
    this.busy = true;
    this.update({ phase: "SAVING", error: "" });
    try {
      const status = await this.api.cancel(this.session);
      if (status.state !== "CANCELLED") throw new Error("Worker did not confirm cancellation.");
      this.update({ phase: "CANCELLED", backendState: "CANCELLED", error: "", noteId: null, savedNote: null, saveStatus: "NONE" });
    } catch (error) {
      const detail = error instanceof BusinessApiError ? `${error.code} (${error.status}): ${error.message}` : error instanceof Error ? error.message : "Cancellation failed.";
      this.update({ phase: "ERROR", error: detail });
    } finally { this.busy = false; }
  }

  private async verifySavedNote(noteId: string, expected: ReviewDraft) {
    try {
      const status = await this.api.getSession(this.session);
      if (status.state !== "COMPLETED" || status.currentDraftRevision !== expected.revision ||
          status.reviewedRevision !== expected.revision || status.approvedRevision !== expected.revision) {
        throw new Error("Saved session revision does not match the approved review.");
      }
      const note = await this.api.getNote(this.session, noteId);
      if (note.id !== noteId || note.sessionId !== this.session.id || note.revision !== expected.revision || !sameDraftContent(note.content, expected.content)) {
        throw new Error("Retrieved note does not match the approved draft revision.");
      }
      this.update({ phase: "COMPLETED", backendState: "COMPLETED", noteId, savedNote: note, saveStatus: "VERIFIED", error: "" });
    } catch (error) {
      const detail = error instanceof BusinessApiError ? `${error.code} (${error.status}): ${error.message}` : error instanceof Error ? error.message : "Saved note could not be verified.";
      this.update({ phase: "SAVE_CONFIRMED_UNVERIFIED", backendState: "COMPLETED", noteId, savedNote: null, saveStatus: "VERIFICATION_FAILED", error: `SAVE CONFIRMED, RETRIEVAL VERIFICATION FAILED: ${detail}` });
    }
  }
  private async loadReview(expectedRevision?: number) {
    const draft = await this.api.review(this.session);
    const status = await this.api.getSession(this.session);
    if (status.state !== "AWAITING_APPROVAL" || status.currentDraftRevision !== draft.revision ||
        (expectedRevision !== undefined && expectedRevision !== draft.revision)) throw new Error("Review state or revision does not match the Worker.");
    this.update({ phase: status.state, backendState: status.state, draft, reviewedRevision: status.reviewedRevision ?? draft.revision, question: "", questionIdentity: undefined, error: "" });
  }
}
