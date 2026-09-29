import { useEffect, useMemo, useState } from "react";
import { apiBaseUrl, getHealth } from "../services/api";
import { useBrowserSession } from "../hooks/useBrowserSession";
import { TurnstileWidget } from "../components/TurnstileWidget";
import { useStt } from "../hooks/useStt";
import { useBusinessWorkflow } from "../hooks/useBusinessWorkflow";
import { DraftReview } from "../components/DraftReview";
import { HalfDuplexGate } from "../services/audio/halfDuplex";
import { useTts } from "../hooks/useTts";
import type { TtsTarget } from "../services/tts/controller";
import { classifyReviewIntent } from "../services/review/intents";

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
    if (success) tts.autoPlay(success);
    else if (followUp) tts.autoPlay(followUp);
    else if (review) tts.autoPlay(review);
  }, [success?.identity, followUp?.identity, review?.identity, tts.snapshot.ready, business.snapshot.backendState]);

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

  const reviewReady = business.canStartReviewCapture() && !ttsBusy && audioGate.active !== "tts";
  const businessListeningReady = business.canStartListening() && !ttsBusy && audioGate.active !== "tts";
  const startListeningLabel = correctionMode ? "Start Correction" : business.snapshot.backendState === "AWAITING_APPROVAL" ? "Start Decision Listening" : business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "Start Answer" : "Start Listening";
  const startListeningAllowed = business.snapshot.backendState === "AWAITING_APPROVAL" ? reviewReady : businessListeningReady;
  const isReviewState = business.snapshot.backendState === "AWAITING_APPROVAL" && Boolean(business.snapshot.draft);

  return <main>
    <h1>GroomNote Web Test</h1>
    <p>Backend status: <span role="status">{status}</span></p>
    <p>API URL: <code>{baseUrl}</code></p>
    <section aria-label="Session bootstrap">
      <h2>Session</h2>
      {siteKey ? <TurnstileWidget siteKey={siteKey} onToken={setTurnstileToken} /> : <p>Turnstile site key is not configured.</p>}
      <label>Appointment ID <input value={appointmentId} onChange={event => setAppointmentId(event.target.value)} /></label>
      <button disabled={!turnstileToken || !appointmentId || browserSession.state === "LOADING"} onClick={() => browserSession.create(appointmentId, turnstileToken)}>Create Session</button>
      <p>State: <span data-testid="session-state">{browserSession.state}</span></p>
      {browserSession.error && <p role="alert">{browserSession.error}</p>}
      {browserSession.session && <><p>Session: {browserSession.session.id}</p><p>Appointment prompt: {browserSession.session.openingPrompt}</p><p>Worker state: {business.snapshot.backendState}</p><p>Credential: READY</p></>}
    </section>
    {browserSession.session && <section aria-label="Streaming transcription">
      <h2>Speech output</h2>
      <p>Audio: {tts.snapshot.ready ? "READY" : "DISABLED"}</p>
      <p>TTS state: <span data-testid="tts-state">{tts.snapshot.state}</span></p>
      <button onClick={() => { void tts.unlock(); }}>Enable Voice</button>
      <button disabled={!opening || !canPlay} onClick={() => { if (opening) void tts.play(opening); }}>Play Opening</button>
      {currentSpeech && <button disabled={!canPlay} onClick={() => { void tts.play(currentSpeech); }}>Repeat Current Speech</button>}
      <button disabled={!ttsBusy} onClick={() => tts.stop()}>Stop Audio</button>
      {tts.snapshot.error && business.snapshot.phase !== "COMPLETED" && <p role="alert">Speech: {tts.snapshot.error}</p>}
      <h2>STT</h2>
      <p>Business State: <span data-testid="business-state">{business.snapshot.phase}</span></p>
      <p>STT state: <span data-testid="stt-state">{stt.snapshot.state}</span></p>
      <p>Microphone: {stt.snapshot.microphone || "None"}</p>
      <button disabled={!(["IDLE", "CLOSED", "ERROR"].includes(stt.snapshot.state)) || !startListeningAllowed} onClick={() => { if (business.snapshot.backendState === "AWAITING_APPROVAL") startDecisionCapture(); else void stt.start("business"); }}>{startListeningLabel}</button>
      <button disabled={stt.snapshot.state !== "LISTENING"} onClick={() => { void finishVoiceInput(); }}>{stt.snapshot.captureMode === "business" ? "Finish STT Round" : "Finish Voice Input"}</button>
      <p>Partial: <span data-testid="partial-transcript">{stt.snapshot.partial}</span></p>
      <h3>Final transcript</h3>
      <ol>{stt.snapshot.finalTurns.map(turn => <li key={turn.order}>Turn {turn.order + 1}: {turn.transcript}</li>)}</ol>
      {business.snapshot.transcriptRounds.filter(round => round.roundId !== stt.snapshot.completedRoundId).map((round, index) =>
        <div key={round.roundId}><h4>Earlier STT round {index + 1}</h4>{round.turns.map(turn => <p key={turn.order}>{turn.transcript}</p>)}</div>)}
      <p>Round: {stt.snapshot.round}</p>
      <p>Persisted finalized turns: {stt.snapshot.persisted}</p>
      {stt.snapshot.error && <p role="alert">{stt.snapshot.error}</p>}
      <button disabled={stt.snapshot.state !== "CLOSED" || !business.canAnalyze()} onClick={() => { void business.analyze(); }}>
        {business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "Analyze Answer" : "Finish & Analyze"}
      </button>
      {business.snapshot.phase === "ANALYZING" && <p>Analyzing grooming note...</p>}
      {business.snapshot.question && business.snapshot.backendState === "AWAITING_FOLLOWUP" && <p>GroomNote asks: <span data-testid="follow-up-question">{business.snapshot.question}</span></p>}
      {business.snapshot.backendState === "REVIEWING" && business.snapshot.phase === "ERROR" && <button onClick={() => { void business.resumeReview(); }}>Load Review</button>}
      {business.snapshot.draft && <DraftReview draft={business.snapshot.draft} />}
      {business.snapshot.error && <p role="alert">{business.snapshot.error}</p>}
      {voiceMessage && <p role="status" data-testid="voice-message">{voiceMessage}</p>}
      {isReviewState && business.snapshot.draft && <section aria-label="Review actions">
        <h3>Review Actions</h3>
        <p>Reviewed revision: {business.snapshot.reviewedRevision}</p>
        <button disabled={!review || !canPlay} onClick={() => { if (review) void tts.play(review); }}>Repeat Summary</button>
        <button disabled={!reviewReady} onClick={() => { setCorrectionMode(true); setVoiceMessage("Start a new voice round and describe the correction."); }}>Correct</button>
        <button disabled={!reviewReady} onClick={() => setVoiceMessage("Full-note speech is not available yet. The complete structured draft remains visible above.")}>Read Full Note</button>
        <button disabled={!reviewReady || ttsBusy || audioGate.active !== null} onClick={() => { setVoiceMessage(""); void business.approve(); }}>Save</button>
        <button disabled={!reviewReady || ttsBusy || audioGate.active !== null} onClick={() => { setVoiceMessage(""); void business.cancel(); }}>Discard</button>
        {correctionMode && <p data-testid="correction-mode">Correction mode: describe one specific change, then finish the voice input.</p>}
      </section>}
      {business.snapshot.phase === "SAVING" && <p role="status">SAVING — waiting for the Worker.</p>}
      {business.snapshot.phase === "VERIFYING_SAVE" && <p role="status">Save confirmed. Verifying the retrieved note…</p>}
      {business.snapshot.phase === "SAVE_CONFIRMED_UNVERIFIED" && <p role="alert">{business.snapshot.error}<button onClick={() => { void business.retrySavedNoteVerification(); }}>Retry Note Verification</button></p>}
      {business.snapshot.phase === "COMPLETED" && business.snapshot.savedNote && <section aria-label="Saved note" data-testid="saved-note">
        <h3>COMPLETED — persistence verified</h3>
        <p>Saved Note ID: <span data-testid="saved-note-id">{business.snapshot.noteId}</span></p>
        <p>Pet: {business.snapshot.savedNote.content.petName}</p>
        <p>Saved Revision: {business.snapshot.savedNote.revision}</p>
        <p>Persistence: VERIFIED</p>
        {tts.snapshot.state === "ERROR" && <p role="alert">Note is saved. Success speech failed: {tts.snapshot.error}</p>}
      </section>}
      {business.snapshot.backendState === "CANCELLED" && <p data-testid="cancelled-state">CANCELLED — no note was saved.</p>}
    </section>}
  </main>;
}
