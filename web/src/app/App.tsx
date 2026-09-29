import { useEffect, useState } from "react";
import { apiBaseUrl, getHealth } from "../services/api";
import { useBrowserSession } from "../hooks/useBrowserSession";
import { TurnstileWidget } from "../components/TurnstileWidget";
import { useStt } from "../hooks/useStt";
import { useBusinessWorkflow } from "../hooks/useBusinessWorkflow";
import { DraftReview } from "../components/DraftReview";

export function App({ baseUrl = apiBaseUrl(import.meta.env.VITE_API_BASE_URL), fetcher = fetch }: { baseUrl?: string; fetcher?: typeof fetch }) {
  const [status, setStatus] = useState<"Checking..." | "Healthy" | "Unavailable">("Checking...");
  const [appointmentId, setAppointmentId] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const browserSession = useBrowserSession(baseUrl, fetcher);
  const stt = useStt(browserSession.session, baseUrl, fetcher);
  const business = useBusinessWorkflow(browserSession.session, stt.snapshot, baseUrl, fetcher);
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || (import.meta.env.DEV ? "1x00000000000000000000AA" : "");

  useEffect(() => {
    let active = true;
    getHealth(baseUrl, fetcher).then(
      () => { if (active) setStatus("Healthy"); },
      () => { if (active) setStatus("Unavailable"); },
    );
    return () => { active = false; };
  }, [baseUrl, fetcher]);

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
      <h2>STT</h2>
      <p>Business State: <span data-testid="business-state">{business.snapshot.phase}</span></p>
      <p>STT state: <span data-testid="stt-state">{stt.snapshot.state}</span></p>
      <p>Microphone: {stt.snapshot.microphone || "None"}</p>
      <button disabled={!(["IDLE", "CLOSED", "ERROR"].includes(stt.snapshot.state)) || !business.canStartListening()} onClick={() => { void stt.start(); }}>{business.snapshot.backendState === "AWAITING_FOLLOWUP" ? "Start Answer" : "Start Listening"}</button>
      <button disabled={!(["CONNECTING", "LISTENING"].includes(stt.snapshot.state))} onClick={() => { void stt.finish(); }}>Finish STT Round</button>
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
    </section>}
  </main>;
}
