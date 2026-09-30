import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { PawPrint } from "@phosphor-icons/react/dist/csr/PawPrint";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { SpeakerHigh } from "@phosphor-icons/react/dist/csr/SpeakerHigh";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { apiBaseUrl, getHealth } from "../services/api";
import { useBrowserSession } from "../hooks/useBrowserSession";
import { useStt } from "../hooks/useStt";
import { useBusinessWorkflow } from "../hooks/useBusinessWorkflow";
import { DraftReview } from "../components/DraftReview";
import { ProcessRail, type ProcessStep } from "../components/ProcessRail";
import { SavedCompletion } from "../components/SavedCompletion";
import { SessionSetupCard } from "../components/SessionSetupCard";
import { HalfDuplexGate } from "../services/audio/halfDuplex";
import { useTts } from "../hooks/useTts";
import type { TtsTarget } from "../services/tts/controller";
import { classifyReviewIntent } from "../services/review/intents";
import { useOrchestration } from "../hooks/useOrchestration";

export function App({ baseUrl = apiBaseUrl(import.meta.env.VITE_API_BASE_URL), fetcher = fetch }: { baseUrl?: string; fetcher?: typeof fetch }) {
  const [status, setStatus] = useState<"Checking..." | "Healthy" | "Unavailable">("Checking...");
  const [appointmentId, setAppointmentId] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [correctionMode, setCorrectionMode] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState("");
  const browserSession = useBrowserSession(baseUrl, fetcher);
  const audioGate = useMemo(() => new HalfDuplexGate(), [browserSession.session?.id]);
  const stt = useStt(browserSession.session, baseUrl, fetcher, audioGate);
  const business = useBusinessWorkflow(browserSession.session, stt.snapshot, baseUrl, fetcher);
  const tts = useTts(browserSession.session, baseUrl, fetcher, audioGate);
  const orchestration = useOrchestration(stt.controller, tts.controller, business.controller, audioGate, stt.snapshot, tts.unlock, async () => { if (!await browserSession.create(appointmentId, turnstileToken)) throw new Error("Session could not be created. Refresh verification and retry."); });
  const opening: TtsTarget | null = browserSession.session ? { kind: "opening", identity: "opening" } : null;
  const followUp: TtsTarget | null = business.snapshot.backendState === "AWAITING_FOLLOWUP" && business.snapshot.question
    ? { kind: "follow_up", identity: business.snapshot.questionIdentity ?? business.snapshot.question } : null;
  const review: TtsTarget | null = business.snapshot.backendState === "AWAITING_APPROVAL" && business.snapshot.draft
    ? { kind: "summary", identity: `${business.snapshot.draft.revision}:${business.snapshot.draft.spokenSummary}` } : null;
  const success: TtsTarget | null = business.snapshot.saveStatus === "VERIFIED" && business.snapshot.noteId
    ? { kind: "save_confirmation", identity: business.snapshot.noteId } : null;
  const currentSpeech = success ?? review ?? followUp ?? opening;
  const ttsBusy = ["REQUESTING", "DECODING", "PLAYING", "STOPPING"].includes(tts.snapshot.state);
  const canPlay = tts.snapshot.ready && !ttsBusy && audioGate.active !== "stt";
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || (import.meta.env.DEV ? "1x00000000000000000000AA" : "");

  useEffect(() => {
    let active = true;
    getHealth(baseUrl, fetcher).then(
      () => { if (active) setStatus("Healthy"); },
      () => { if (active) setStatus("Unavailable"); },
    );
    return () => { active = false; };
  }, [baseUrl, fetcher]);

  useEffect(() => {
    if (orchestration.snapshot.ownsWorkflow) return;
    if (success) tts.autoPlay(success);
    else if (followUp) tts.autoPlay(followUp);
    else if (review) tts.autoPlay(review);
  }, [success?.identity, followUp?.identity, review?.identity, tts.snapshot.ready, business.snapshot.backendState, orchestration.snapshot.ownsWorkflow]);

  async function finishVoiceInput() {
    if (stt.snapshot.captureMode === "business") { await stt.finish(); return; }
    const capture = await stt.finishAndGet();
    const roundId = capture.completedRoundId;
    const transcript = capture.capturedText.trim();
    if (!roundId) { setVoiceMessage("No completed voice capture is available."); return; }
    if (!transcript) {
      await stt.discardBufferedCapture();
      setVoiceMessage("No finalized speech was captured. You can try again.");
      return;
    }
    if (capture.captureMode === "correction") {
      const result = await business.correct(transcript, roundId);
      if (result?.phase !== "ERROR" && result?.backendState === "AWAITING_APPROVAL") {
        stt.acknowledgeBufferedCaptureConsumed(roundId);
        setCorrectionMode(false);
        setVoiceMessage("");
      } else {
        await stt.discardBufferedCapture();
        setVoiceMessage(result?.error || "Correction was not applied. The existing review is still available.");
      }
      return;
    }

    const intent = classifyReviewIntent(transcript);
    if (intent.kind === "correct") {
      const result = await business.correct(intent.transcript, roundId);
      if (result?.phase !== "ERROR" && result?.backendState === "AWAITING_APPROVAL") {
        stt.acknowledgeBufferedCaptureConsumed(roundId);
        setCorrectionMode(false);
        setVoiceMessage("");
      } else {
        await stt.discardBufferedCapture();
        setVoiceMessage(result?.error || "Correction was not applied. The existing review is still available.");
      }
      return;
    }

    try { await stt.completeBufferedCapture(); }
    catch (error) { setVoiceMessage(error instanceof Error ? error.message : "Voice decision could not be closed safely."); return; }
    if (intent.kind === "approve") { setVoiceMessage(""); await business.approve(); }
    else if (intent.kind === "discard") { setVoiceMessage(""); await business.cancel(); }
    else if (intent.kind === "repeat") {
      setVoiceMessage("");
      if (review && canPlay) await tts.play(review);
      else setVoiceMessage("Summary playback is unavailable right now.");
    }
    else if (intent.kind === "enter_correction") {
      setCorrectionMode(true);
      setVoiceMessage("Correction mode is ready. Start a new voice round and describe the change.");
    }
    else if (intent.kind === "full_readback") {
      setVoiceMessage("Full-note speech is not available yet. The complete structured draft remains visible below.");
    }
    else setVoiceMessage("I could not confirm that action. Say “Save the note,” “Correction,” or “Discard the note.” Nothing was saved.");
  }

  function startDecisionCapture() {
    setVoiceMessage("");
    void stt.start(correctionMode ? "correction" : "review");
  }

  const reviewReady = business.canStartReviewCapture() && stt.snapshot.state !== "LISTENING" && !ttsBusy && audioGate.active !== "tts";
  const businessListeningReady = business.canStartListening() && !ttsBusy && audioGate.active !== "tts";
  const startListeningLabel = correctionMode ? "Start Correction" : business.snapshot.backendState === "AWAITING_APPROVAL" ? "Start Decision Listening" : business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "Start Answer" : "Start Listening";
  const startListeningAllowed = business.snapshot.backendState === "AWAITING_APPROVAL" ? reviewReady : businessListeningReady;
  const isReviewState = business.snapshot.backendState === "AWAITING_APPROVAL" && Boolean(business.snapshot.draft);
  const isVerifiedSave = business.snapshot.phase === "COMPLETED" && Boolean(business.snapshot.savedNote && browserSession.session);
  const isCancelled = business.snapshot.backendState === "CANCELLED";
  const processStep: ProcessStep = isVerifiedSave ? "saved" : !browserSession.session ? "session" : isReviewState || business.snapshot.phase === "ANALYZING" ? "recap" : "grooming";
  const activePrompt = !browserSession.session
    ? "Create a secure appointment session to begin."
    : business.snapshot.backendState === "AWAITING_FOLLOWUP" && business.snapshot.question
      ? business.snapshot.question
      : correctionMode
        ? "Describe one specific change to the current handover."
        : isReviewState
          ? "Review the structured recap below. Nothing is saved until you explicitly approve it."
          : business.snapshot.phase === "ANALYZING"
            ? "GroomNote is organizing the details you shared."
            : browserSession.session.openingPrompt;
  const stateLabel = isCancelled ? "CANCELLED" : business.snapshot.phase === "COMPLETED" ? "COMPLETED" : business.snapshot.backendState;

  return <main className="groomnote-shell" onClickCapture={orchestration.manualClick}>
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true"><PawPrint size={26} weight="fill" /></span>
        <div><h1>GroomNote AI</h1><p>Your grooming handover, made simple</p></div>
      </div>
      <div className="topbar__status">
        <span className={`connection-pill connection-pill--${status === "Healthy" ? "healthy" : status === "Unavailable" ? "unavailable" : "checking"}`}>
          <span className="connection-dot" aria-hidden="true" />
          Backend <span role="status" aria-label="Backend status">{status}</span>
        </span>
        <span className="session-pill"><span data-testid="session-state">{browserSession.state}</span> · {browserSession.session ? `Session: ${browserSession.session.id}` : "No active session"}</span>
        {browserSession.session && <p className="visually-hidden">Session: {browserSession.session.id}</p>}
        {browserSession.session && <><span className="visually-hidden">Credential: READY</span><span className="visually-hidden">Worker state: {business.snapshot.backendState}</span></>}
        {browserSession.session && <span className="visually-hidden" data-testid="business-state">{business.snapshot.phase}</span>}
        <span className="visually-hidden">API URL: <code>{baseUrl}</code></span>
      </div>
    </header>

    <section className={`hero-row${isVerifiedSave ? " hero-row--completed" : ""}`} aria-labelledby="screen-title">
      <div className="hero-copy">
        <div className="context-chips">
          {browserSession.session && <span className="context-chip"><PawPrint size={15} weight="duotone" aria-hidden="true" />
            <span><small>PET</small>{business.snapshot.draft?.content.petName ?? "To be identified"}</span></span>}
          {browserSession.session && appointmentId && <span className="context-chip context-chip--appointment">
            <span><small>APPOINTMENT</small>{appointmentId.slice(-8)}</span></span>}
          {!browserSession.session && <span className="context-chip context-chip--intro"><PawPrint size={15} weight="duotone" aria-hidden="true" /><span>GROOMING VOICE ASSISTANT</span></span>}
        </div>
        <h2 id="screen-title">{isVerifiedSave ? "Your grooming report is ready" : "Tell GroomNote how today’s grooming went"}</h2>
        <p className="hero-subtitle">{isVerifiedSave && business.snapshot.savedNote ? `Saved and verified for ${business.snapshot.savedNote.content.petName}.` : browserSession.session ? activePrompt : "A clear, thoughtful handover begins with your words."}</p>
        <p className="visually-hidden">Backend status: <span>{status}</span></p>
      </div>
      <div className={`hero-art${stt.snapshot.state === "LISTENING" ? " hero-art--listening" : ""}`} aria-hidden="true">
        <img src="/assets/voice-listening.svg" alt="" />
      </div>
    </section>

    <section className="workflow-actions" aria-label="GroomNote voice workflow">
      <button data-orchestration className="button button--primary" disabled={orchestration.snapshot.state !== "IDLE" || (browserSession.session !== null && business.snapshot.backendState !== "COLLECTING") || (!browserSession.session && (!turnstileToken || !appointmentId.trim() || browserSession.state === "LOADING"))} onClick={() => { void orchestration.start(); }}>Start GroomNote</button>
      <span data-testid="orchestration-state" className="visually-hidden">{orchestration.snapshot.state}</span>
      {orchestration.snapshot.message && <p aria-live="polite">{orchestration.snapshot.message}</p>}
      {business.snapshot.backendState === "AWAITING_APPROVAL" && ["RECOVERABLE_ERROR", "MANUAL"].includes(orchestration.snapshot.state) && <button data-orchestration className="button button--secondary" disabled={ttsBusy || ["FINALIZING", "REQUESTING_MIC", "REQUESTING_TOKEN", "CONNECTING"].includes(stt.snapshot.state)} onClick={() => { void orchestration.resumeReview(); }}>Resume voice</button>}
      {business.snapshot.backendState === "AWAITING_APPROVAL" && orchestration.snapshot.state !== "IDLE" && <div aria-label="Voice workflow review controls">
        {(["correct", "repeat", "save", "cancel"] as const).map(action => <button key={action} data-orchestration className="button button--quiet" disabled={ttsBusy || ["FINALIZING", "REQUESTING_MIC", "REQUESTING_TOKEN", "CONNECTING"].includes(stt.snapshot.state) || ["SAVING", "CORRECTING", "VERIFYING_SAVE"].includes(business.snapshot.phase)} onClick={() => { if (action === "correct") setCorrectionMode(true); void orchestration.manualReview(action); }}>{action[0].toUpperCase() + action.slice(1)}</button>)}
      </div>}
    </section>
    {!browserSession.session ? <div className="setup-layout">
      <SessionSetupCard siteKey={siteKey} appointmentId={appointmentId} setAppointmentId={setAppointmentId}
        turnstileToken={turnstileToken} setTurnstileToken={setTurnstileToken} state={browserSession.state}
        error={browserSession.error} onCreate={() => { void browserSession.create(appointmentId, turnstileToken); }} />
      <aside className="setup-note panel">
        <div className="setup-note__symbol"><Microphone size={25} weight="duotone" aria-hidden="true" /></div>
        <p className="eyebrow">VOICE FIRST</p>
        <h2>One natural recap is all it takes.</h2>
        <p>Share the services, anything you noticed, and what the next groomer should know. GroomNote will organize the details for your review.</p>
      </aside>
    </div> : isVerifiedSave && business.snapshot.savedNote ? <SavedCompletion session={browserSession.session} note={business.snapshot.savedNote} speechError={tts.snapshot.state === "ERROR" ? tts.snapshot.error : ""} /> : <div className="recap-layout">
      <div className="recap-column">
        <section className={`voice-card panel${stt.snapshot.state === "LISTENING" ? " voice-card--listening" : ""}`} aria-label="Voice recap controls">
          <div className="panel-heading">
            <div><p className="eyebrow">{business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "A LITTLE MORE DETAIL" : correctionMode ? "UPDATE THE RECAP" : "VOICE RECAP"}</p>
              <h3>{business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "One quick follow-up" : correctionMode ? "What should we change?" : "Tell us in your own words"}</h3></div>
            <span className={`state-badge state-badge--${stt.snapshot.state.toLowerCase()}`}>{stateLabel}</span>
          </div>

          <div className="prompt-strip">
            <span className="prompt-strip__icon"><SpeakerHigh size={19} weight="duotone" aria-hidden="true" /></span>
            <div><p className="eyebrow">{business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "GROOMNOTE ASKS" : correctionMode ? "CORRECTION PROMPT" : "YOUR PROMPT"}</p>
              <p className="prompt-strip__text" data-testid={business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "follow-up-question" : undefined}>{activePrompt}</p>
              {business.snapshot.backendState === "AWAITING_FOLLOWUP" && <span className="visually-hidden">GroomNote asks: </span>}
            </div>
          </div>
          <p className="visually-hidden">Appointment prompt: {browserSession.session.openingPrompt}</p>

          <div className="capture-status-row">
            <div className="capture-status-copy">
              <span className={`mic-status mic-status--${stt.snapshot.state.toLowerCase()}`} aria-hidden="true"><Microphone size={18} weight="fill" /></span>
              <div><strong>{stt.snapshot.state === "LISTENING" ? "Listening now" : stt.snapshot.state === "FINALIZING" ? "Finishing your words" : stt.snapshot.state === "ERROR" ? "Microphone needs attention" : "Ready when you are"}</strong>
                <small>STT state: <span data-testid="stt-state">{stt.snapshot.state}</span>{stt.snapshot.microphone ? ` · ${stt.snapshot.microphone}` : ""}</small></div>
            </div>
            <span className="audio-ready-label">{tts.snapshot.ready ? "AUDIO READY" : "AUDIO SETUP"}</span>
          </div>
          <span className="visually-hidden">Audio: {tts.snapshot.ready ? "READY" : "DISABLED"}</span>

          <div className="voice-actions">
            <button className="button button--voice" disabled={!startListeningAllowed || !["IDLE", "CLOSED", "ERROR"].includes(stt.snapshot.state)} onClick={() => { if (business.snapshot.backendState === "AWAITING_APPROVAL") startDecisionCapture(); else void stt.start("business"); }}>
              <Microphone size={21} weight="fill" aria-hidden="true" /> {startListeningLabel}
            </button>
            <button className="button button--secondary" disabled={stt.snapshot.state !== "LISTENING"} onClick={() => { void finishVoiceInput(); }}>
              <Stop size={18} weight="fill" aria-hidden="true" /> {stt.snapshot.captureMode === "business" ? "Finish STT Round" : "Finish Voice Input"}
            </button>
          </div>

          <div className="workflow-actions">
            {browserSession.session && <>
              <button className="button button--quiet" onClick={() => { void tts.unlock(); }}>{tts.snapshot.ready ? "Voice enabled" : "Enable Voice"}</button>
              <button className="button button--quiet" disabled={!opening || !canPlay} onClick={() => { if (opening) void tts.play(opening); }}><Play size={16} weight="fill" aria-hidden="true" /> Play Opening</button>
              {currentSpeech && <button className="button button--quiet" disabled={!canPlay} onClick={() => { void tts.play(currentSpeech); }}><ArrowClockwise size={16} aria-hidden="true" /> Repeat Current Speech</button>}
              <button className="button button--quiet" disabled={!ttsBusy} onClick={() => tts.stop()}><Stop size={16} aria-hidden="true" /> Stop Audio</button>
            </>}
          </div>
          {tts.snapshot.error && <p className="inline-alert" role="alert">Speech output: {tts.snapshot.error}</p>}

          <div className="round-actions">
            <span className="transport-pill"><SpeakerHigh size={15} aria-hidden="true" /> TTS <span data-testid="tts-state">{tts.snapshot.state}</span></span>
            <span className="transport-pill"><span className="connection-dot" aria-hidden="true" /> Business <span>{business.snapshot.backendState}</span></span>
            <button className="button button--analyze" disabled={stt.snapshot.state !== "CLOSED" || !business.canAnalyze()} onClick={() => { void business.analyze(); }}>
              {business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "Analyze Answer" : "Finish & Analyze"}
            </button>
          </div>
          {business.snapshot.phase === "ANALYZING" && <p className="analysis-note" role="status">Analyzing grooming note...</p>}
          {stt.snapshot.error && <p className="inline-alert" role="alert">{stt.snapshot.error}</p>}
          {business.snapshot.error && <p className="inline-alert" role="alert">{business.snapshot.error}</p>}
          {voiceMessage && <p className="voice-message" role="status" data-testid="voice-message">{voiceMessage}</p>}
          {business.snapshot.phase === "REVIEWING" && <button className="button button--secondary" onClick={() => { void business.resumeReview(); }}>Load Review</button>}
          {business.snapshot.phase === "SAVE_CONFIRMED_UNVERIFIED" && <div className="inline-alert" role="alert">{business.snapshot.error} <button className="text-button" onClick={() => { void business.retrySavedNoteVerification(); }}>Retry note verification</button></div>}
          {isCancelled && <p data-testid="cancelled-state" className="cancelled-note">CANCELLED — no note was saved.</p>}
        </section>

        <section className="transcript-card panel" aria-label="Live transcript">
          <div className="panel-heading panel-heading--compact">
            <div><p className="eyebrow">YOUR WORDS</p><h3>Live Transcript</h3></div>
            <span className="transcript-count">{stt.snapshot.persisted} saved {stt.snapshot.persisted === 1 ? "turn" : "turns"}</span>
          </div>
          <div className="partial-transcript"><span className="partial-dot" aria-hidden="true" />
            <span data-testid="partial-transcript">{stt.snapshot.partial || (stt.snapshot.state === "LISTENING" ? "Listening for your next words…" : "Live words will appear here as you speak.")}</span>
          </div>
          <ol className="transcript-list" aria-label="Finalized transcript turns">
            {stt.snapshot.finalTurns.map(turn => <li key={turn.order}><span className="turn-number">{String(turn.order + 1).padStart(2, "0")}</span><span>{turn.transcript}</span></li>)}
          </ol>
          {business.snapshot.transcriptRounds.filter(round => round.roundId !== stt.snapshot.completedRoundId).map((round, index) => <details className="earlier-round" key={round.roundId}>
            <summary>Earlier STT round {index + 1}</summary>
            {round.turns.map(turn => <p key={turn.order}>{turn.transcript}</p>)}
          </details>)}
          <p className="transcript-footnote">Round: {stt.snapshot.round} <span>·</span> Finalized turns persist to this session.</p>
          <span className="visually-hidden">Persisted finalized turns: {stt.snapshot.persisted}</span>
        </section>
      </div>

      <div className="notes-column">
        <section className="notes-card panel" aria-label="Grooming notes">
          <div className="panel-heading">
            <div><p className="eyebrow">THE HANDOVER</p><h3>Structured Notes</h3></div>
          </div>
          {business.snapshot.draft
            ? <DraftReview draft={business.snapshot.draft} />
            : <div className="notes-empty">
              <img src="/assets/voice-listening.svg" alt="" aria-hidden="true" />
              <p>{business.snapshot.phase === "ANALYZING" ? "GroomNote is shaping the details into a clear handover." : "Your grooming details and next-visit notes will appear here after analysis."}</p>
            </div>}
          {business.snapshot.phase === "AWAITING_APPROVAL" && business.snapshot.draft && <section className="review-actions" aria-label="Review actions">
            <div className="review-actions__heading"><div><p className="eyebrow">YOUR REVIEW</p><h4>Does this look right?</h4></div>
              <span className="reviewed-revision">Reviewed revision {business.snapshot.reviewedRevision}</span></div>
            <div className="review-actions__buttons">
              <button className="button button--quiet" disabled={!review || !canPlay} onClick={() => { if (review) void tts.play(review); }}><ArrowClockwise size={16} aria-hidden="true" /> Repeat Summary</button>
              <button className="button button--secondary" disabled={!reviewReady} onClick={() => { setCorrectionMode(true); setVoiceMessage("Start a new voice round and describe the correction."); }}>Correct</button>
              <button className="button button--quiet" disabled={!reviewReady} onClick={() => setVoiceMessage("Full-note speech is not available yet. The complete structured draft remains visible above.")}>Read Full Note</button>
              <button className="button button--primary" disabled={!reviewReady || ttsBusy || audioGate.active !== null} onClick={() => { setVoiceMessage(""); void business.approve(); }}><CheckCircle size={18} weight="fill" aria-hidden="true" /> Save</button>
              <button className="button button--danger" disabled={!reviewReady || ttsBusy || audioGate.active !== null} onClick={() => { setVoiceMessage(""); void business.cancel(); }}>Discard</button>
            </div>
            {correctionMode && <p data-testid="correction-mode" className="correction-hint">Correction mode: describe one specific change, then finish the voice input.</p>}
          </section>}
        </section>
      </div>
    </div>}

    {business.snapshot.phase === "SAVING" && <div className="operation-banner" role="status">Saving note… waiting for Worker confirmation.</div>}
    {business.snapshot.phase === "VERIFYING_SAVE" && <div className="operation-banner" role="status">Save confirmed. Retrieving the saved note for verification…</div>}
    <footer className="process-footer">
      <span className="process-footer__caption">GROOMNOTE SESSION</span>
      <ProcessRail current={processStep} />
      <span className="visually-hidden">API: {baseUrl}</span>
    </footer>
  </main>;
}
