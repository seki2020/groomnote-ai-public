import type { BrowserSession } from "../api";
import type { FinalTurn } from "../stt/transcript";
import { BusinessApiError, type BusinessApi, type BusinessState, type ReviewDraft } from "./api";

export type BusinessPhase = BusinessState | "ERROR";
export interface CompletedTranscriptRound { roundId: string; turns: FinalTurn[] }
export interface BusinessSnapshot {
  phase: BusinessPhase;
  backendState: BusinessState;
  question: string;
  questionIdentity?: string;
  draft: ReviewDraft | null;
  transcriptRounds: CompletedTranscriptRound[];
  error: string;
}

export class BusinessController {
  private value: BusinessSnapshot = { phase: "COLLECTING", backendState: "COLLECTING", question: "", draft: null, transcriptRounds: [], error: "" };
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
  private async loadReview(expectedRevision?: number) {
    const draft = await this.api.review(this.session);
    const status = await this.api.getSession(this.session);
    if (status.state !== "AWAITING_APPROVAL" || status.currentDraftRevision !== draft.revision ||
        (expectedRevision !== undefined && expectedRevision !== draft.revision)) throw new Error("Review state or revision does not match the Worker.");
    this.update({ phase: status.state, backendState: status.state, draft, question: "", questionIdentity: undefined, error: "" });
  }
}
