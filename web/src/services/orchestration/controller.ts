import type { SttSnapshot, SttCaptureMode } from "../stt/controller";
import type { TtsTarget } from "../tts/controller";
import type { FinalTurn } from "../stt/transcript";
import { classifyReviewIntent } from "../review/intents";
import { extractFinishCommand, isPrepareConfirmation, withoutFinishCommand } from "./commands";
import type { OrchestrationOptions, OrchestrationPorts, OrchestrationSnapshot, OrchestrationState } from "./types";

/** Browser interaction only. Existing controllers and Worker own all business data. */
export class OrchestrationController {
  private value: OrchestrationSnapshot = { state: "IDLE", ownsWorkflow: false, message: "" };
  private epoch = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private observedSpeech = "";
  private reportState: "LISTENING_REPORT" | "LISTENING_FOLLOWUP" = "LISTENING_REPORT";
  private pendingRound: { id: string; persisted: number } | null = null;
  constructor(private readonly ports: OrchestrationPorts, private readonly notify: (value: OrchestrationSnapshot) => void, private readonly options: OrchestrationOptions = {}) {}
  get snapshot() { return this.value; }
  private clearSilence() { if (this.silenceTimer) clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  private update(state: OrchestrationState, message = "", ownsWorkflow = true) {
    this.clearSilence(); this.value = { state, message, ownsWorkflow }; this.notify(this.value);
  }
  private current(epoch: number) { return epoch === this.epoch && this.value.ownsWorkflow; }
  private fail(error: unknown) {
    this.epoch += 1;
    this.update("RECOVERABLE_ERROR", `${error instanceof Error ? error.message : "Automatic preparation stopped."} Use the manual controls to continue.`, false);
  }
  handoff() { this.epoch += 1; this.update("MANUAL", "Manual controls are available.", false); }
  private run(task: (epoch: number) => Promise<void>) {
    const epoch = this.epoch;
    void task(epoch).catch(error => { if (this.current(epoch)) this.fail(error); });
  }
  private async speak(state: OrchestrationState, target: TtsTarget, epoch: number, message: string): Promise<boolean> {
    if (!this.current(epoch)) return false;
    if (state === "SPEAKING_OPENING" && this.options.forceOpeningFailure) throw new Error("Injected automation failure (development experiment).");
    if (this.ports.gate.active !== null) throw new Error("Microphone must release before speech.");
    this.update(state, message); await this.ports.tts.play(target, true);
    if (!this.current(epoch)) return false;
    if (this.ports.tts.snapshot.state !== "COMPLETED" || this.ports.gate.active !== null) throw new Error(this.ports.tts.snapshot.error || "Speech playback did not complete safely.");
    return true;
  }
  private async listen(state: OrchestrationState, mode: SttCaptureMode, epoch: number, message: string) {
    if (!this.current(epoch)) return;
    if (this.ports.gate.active !== null) throw new Error("Speech must release before listening.");
    this.observedSpeech = ""; this.update(state, message);
    await this.ports.stt.start(mode);
    if (!this.current(epoch)) return;
    if (this.snapshot.state === state && this.ports.stt.snapshot.state !== "LISTENING") throw new Error(this.ports.stt.snapshot.error || "Listening did not start.");
  }
  async start(): Promise<void> {
    if (this.value.state !== "IDLE" || this.ports.business.snapshot.backendState !== "COLLECTING") return;
    const epoch = ++this.epoch; this.update("STARTING", "Starting GroomNote…");
    try {
      await this.ports.tts.unlock();
      if (!this.current(epoch)) return;
      if (!this.ports.tts.snapshot.ready) throw new Error("Enable browser audio to continue.");
      if (await this.speak("SPEAKING_OPENING", { kind: "opening", identity: "opening" }, epoch, "Listen to the opening prompt.")) {
        await this.listen("LISTENING_REPORT", "business", epoch, "Tell me about the groom. Say “That's everything” when finished.");
      }
    } catch (error) { if (this.current(epoch)) this.fail(error); }
  }
  observe(capture: SttSnapshot) {
    if (!this.value.ownsWorkflow || !this.value.state.startsWith("LISTENING_")) return;
    if (capture.state === "ERROR") { this.fail(new Error(capture.error)); return; }
    if (capture.state === "CLOSED") { this.fail(new Error("Listening ended without an explicit command.")); return; }
    if (capture.state !== "LISTENING") return;
    const state = this.value.state;
    const finalized = capture.finalTurns.map(turn => turn.transcript).join(" ").trim();
    if (state === "LISTENING_DECISION") {
      if (!finalized) return;
      // Unknown finalized speech, including bare yes, never invents approval.
      this.update("FINALIZING_DECISION", "Checking your instruction…");
      this.run(epoch => this.decision(epoch)); return;
    }
    const confirmation = state === "LISTENING_CONFIRMATION";
    if (capture.finalTurns.some(turn => extractFinishCommand(turn.transcript).found || (confirmation && isPrepareConfirmation(turn.transcript)))) {
      const correction = state === "LISTENING_CORRECTION";
      this.update(correction ? "PROCESSING_CORRECTION" : this.reportState === "LISTENING_FOLLOWUP" ? "FINALIZING_FOLLOWUP" : "FINALIZING_REPORT", "Preparing your note…");
      this.run(epoch => correction ? this.finishCorrection(epoch) : this.finalize(epoch, confirmation)); return;
    }
    if (this.options.experimentOnly || state === "LISTENING_CORRECTION") return;
    const signature = `${finalized}|${capture.partial}`;
    if (signature === this.observedSpeech) return;
    this.observedSpeech = signature; this.clearSilence();
    if (!finalized) return;
    // Silence only asks a confirmation after finalized meaningful content.
    // New partial/final speech resets this configurable timer.
    this.silenceTimer = setTimeout(() => {
      if (!this.value.ownsWorkflow || !["LISTENING_REPORT", "LISTENING_FOLLOWUP", "LISTENING_CONFIRMATION"].includes(this.value.state)) return;
      this.update("FINALIZING_REPORT", "Pausing to check whether you have more to add…");
      this.run(epoch => this.confirmSilence(epoch));
    }, this.options.silenceMs ?? 6000);
  }
  private async closeCapture(transform?: (turn: FinalTurn) => FinalTurn | null) {
    await this.ports.stt.finish(transform);
    const capture = this.ports.stt.snapshot;
    if (capture.state !== "CLOSED" || this.ports.gate.active !== null || !capture.completedRoundId) throw new Error(capture.error || "Speech could not be finalized safely.");
    return capture;
  }
  private remember(capture: SttSnapshot) {
    if (capture.persisted && capture.completedRoundId) {
      this.ports.business.recordRound(capture.completedRoundId, capture.finalTurns);
      this.pendingRound = { id: capture.completedRoundId, persisted: capture.persisted };
    }
  }
  private async confirmSilence(epoch: number) {
    const capture = await this.closeCapture(); if (!this.current(epoch)) return;
    this.remember(capture);
    if (!this.pendingRound) throw new Error("No finalized report content is available.");
    if (await this.speak("SPEAKING_CONFIRMATION", { kind: "silence_confirmation", identity: "silence_confirmation" }, epoch, "PRIVATE_PROMPT_NOT_INCLUDED")) {
      await this.listen("LISTENING_CONFIRMATION", "business", epoch, "Add more details, or say “Prepare it”.");
    }
  }
  private async finalize(epoch: number, confirmation: boolean) {
    const capture = await this.closeCapture(turn => confirmation && isPrepareConfirmation(turn.transcript) ? null : withoutFinishCommand(turn));
    if (!this.current(epoch)) return;
    this.remember(capture); const round = this.pendingRound;
    if (!round || !this.ports.business.canAnalyze(round.id, round.persisted)) throw new Error("No completed grooming content is available for analysis.");
    this.update("ANALYZING", "Preparing your note…"); await this.ports.business.analyze(round.id);
    if (!this.current(epoch)) return;
    const result = this.ports.business.snapshot;
    if (result.phase === "ERROR" || !["AWAITING_FOLLOWUP", "AWAITING_APPROVAL"].includes(result.backendState)) throw new Error(result.error || "Analysis did not produce a confirmed next step.");
    this.pendingRound = null;
    if (this.options.experimentOnly) { this.update("EXPERIMENT_COMPLETE", "Your report is ready. Use the review controls to continue.", false); return; }
    await this.continueAfterAnalysis(epoch);
  }
  private async continueAfterAnalysis(epoch: number) {
    if (!this.current(epoch)) return;
    const result = this.ports.business.snapshot;
    if (result.backendState === "AWAITING_FOLLOWUP") {
      if (!result.question) throw new Error("The current follow-up question is unavailable.");
      if (await this.speak("SPEAKING_FOLLOWUP", { kind: "follow_up", identity: result.questionIdentity ?? result.question }, epoch, result.question)) {
        this.reportState = "LISTENING_FOLLOWUP";
        await this.listen("LISTENING_FOLLOWUP", "business", epoch, "Answer the question. Say “That's everything” when finished.");
      }
    } else await this.review(epoch);
  }
  private async review(epoch: number) {
    const result = this.ports.business.snapshot;
    if (result.backendState !== "AWAITING_APPROVAL" || !result.draft || result.reviewedRevision !== result.draft.revision) throw new Error("A current reviewed revision is required.");
    if (!await this.speak("SPEAKING_REVIEW", { kind: "summary", identity: `${result.draft.revision}:${result.draft.spokenSummary}` }, epoch, "Listen to your current note.")) return;
    if (this.options.voiceAssisted) { this.update("REVIEW_CONTROLS", "Choose Correct, Repeat, Save, or Cancel.", false); return; }
    await this.listen("LISTENING_DECISION", "review", epoch, "Say “Save the note”, “Correction”, “Repeat that”, or “Discard this note”.");
  }
  private async decision(epoch: number) {
    const capture = await this.closeCapture(withoutFinishCommand); if (!this.current(epoch)) return;
    const intent = classifyReviewIntent(capture.capturedText);
    const id = capture.completedRoundId!;
    if (intent.kind === "correct") { await this.applyCorrection(intent.transcript, id, epoch); return; }
    await this.ports.stt.discardBufferedCapture(); if (!this.current(epoch)) return;
    if (intent.kind === "repeat") { await this.review(epoch); return; }
    if (intent.kind === "enter_correction") {
      if (await this.speak("SPEAKING_CORRECTION_PROMPT", { kind: "correction_prompt", identity: "correction_prompt" }, epoch, "What would you like to change?")) {
        await this.listen("LISTENING_CORRECTION", "correction", epoch, "Describe the change, then say “That's everything”.");
      }
      return;
    }
    if (intent.kind === "discard") {
      await this.ports.business.cancel(); if (!this.current(epoch)) return;
      if (this.ports.business.snapshot.backendState !== "CANCELLED") throw new Error(this.ports.business.snapshot.error || "Cancellation was not confirmed.");
      this.update("CANCELLED", "The note was discarded.", false); return;
    }
    if (intent.kind !== "approve" || !/\b(?:save|approve|approved)\b/i.test(capture.capturedText)) throw new Error("Your decision was not recognized safely. Choose Correct, Repeat, Save, or Cancel.");
    this.update("SAVING", "Saving your reviewed note…"); await this.ports.business.approve();
    if (!this.current(epoch)) return;
    const result = this.ports.business.snapshot;
    if (result.saveStatus !== "VERIFIED" || !result.noteId || !result.savedNote) throw new Error(result.error || "The saved note has not been verified.");
    if (await this.speak("SPEAKING_SUCCESS", { kind: "save_confirmation", identity: result.noteId }, epoch, "Your note is saved and verified.")) this.update("COMPLETED", "Your note is saved and verified.", false);
  }
  private async finishCorrection(epoch: number) {
    const capture = await this.closeCapture(withoutFinishCommand); if (!this.current(epoch)) return;
    if (!capture.capturedText.trim()) { await this.ports.stt.discardBufferedCapture(); throw new Error("No correction was captured."); }
    await this.applyCorrection(capture.capturedText, capture.completedRoundId!, epoch);
  }
  private async applyCorrection(text: string, id: string, epoch: number) {
    const previous = this.ports.business.snapshot.draft?.revision ?? 0;
    this.update("PROCESSING_CORRECTION", "Updating your note…"); await this.ports.business.correct(text, id);
    const result = this.ports.business.snapshot;
    if (result.phase === "ERROR" || !(["AWAITING_APPROVAL", "AWAITING_FOLLOWUP"].includes(result.backendState)) || !result.draft || (result.backendState === "AWAITING_APPROVAL" && result.draft.revision <= previous)) {
      await this.ports.stt.discardBufferedCapture(); throw new Error(result.error || "Correction did not produce a reviewed revision.");
    }
    this.ports.stt.acknowledgeBufferedCaptureConsumed(id);
    if (this.current(epoch)) await this.continueAfterAnalysis(epoch);
  }
  /** Explicit recovery replays confirmed review; it never retries a mutation. */
  async resumeReview() {
    if (!["RECOVERABLE_ERROR", "MANUAL", "REVIEW_CONTROLS", "EXPERIMENT_COMPLETE"].includes(this.value.state) || this.ports.business.snapshot.backendState !== "AWAITING_APPROVAL") return;
    const epoch = ++this.epoch;
    this.update("STARTING", "Resuming your current review…");
    try {
      await this.ports.tts.unlock();
      if (!this.current(epoch)) return;
      if (this.ports.stt.snapshot.state === "LISTENING") await this.closeCapture();
      await this.ports.stt.discardBufferedCapture();
      if (this.current(epoch)) await this.review(epoch);
    } catch (error) { if (this.current(epoch)) this.fail(error); }
  }
  /** Customer controls release decision capture before calling W06 actions. */
  async manualReview(action: "correct" | "repeat" | "save" | "cancel") {
    this.handoff();
    try {
      if (this.ports.stt.snapshot.state === "LISTENING") await this.closeCapture();
      await this.ports.stt.discardBufferedCapture();
      if (this.ports.gate.active !== null) throw new Error("Finish speech playback before using review controls.");
      if (action === "save") await this.ports.business.approve();
      else if (action === "cancel") await this.ports.business.cancel();
      else if (action === "correct") await this.ports.stt.start("correction");
      else {
        const draft = this.ports.business.snapshot.draft;
        if (draft) await this.ports.tts.play({ kind: "summary", identity: `${draft.revision}:${draft.spokenSummary}` });
      }
    } catch (error) { this.fail(error); }
  }
}
