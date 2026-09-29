import { useEffect, useState } from "react";
import { apiBaseUrl, getHealth } from "../services/api";
import { useBrowserSession } from "../hooks/useBrowserSession";
import { TurnstileWidget } from "../components/TurnstileWidget";

export function App({ baseUrl = apiBaseUrl(import.meta.env.VITE_API_BASE_URL), fetcher = fetch }: { baseUrl?: string; fetcher?: typeof fetch }) {
  const [status, setStatus] = useState<"Checking..." | "Healthy" | "Unavailable">("Checking...");
  const [appointmentId, setAppointmentId] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const browserSession = useBrowserSession(baseUrl, fetcher);
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
      {browserSession.session && <><p>Session: {browserSession.session.id}</p><p>Business state: {browserSession.session.state}</p><p>Credential: READY</p></>}
    </section>
  </main>;
}
