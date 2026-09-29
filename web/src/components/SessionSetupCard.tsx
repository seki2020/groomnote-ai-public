import { IdentificationCard } from "@phosphor-icons/react/dist/csr/IdentificationCard";
import { TurnstileWidget } from "./TurnstileWidget";

interface SessionSetupCardProps {
  siteKey: string;
  appointmentId: string;
  setAppointmentId: (value: string) => void;
  turnstileToken: string;
  setTurnstileToken: (value: string) => void;
  state: "IDLE" | "LOADING" | "READY" | "ERROR";
  error: string;
  onCreate: () => void;
}

export function SessionSetupCard(props: SessionSetupCardProps) {
  return <section className="setup-card" aria-label="Session bootstrap">
    <div className="setup-card__heading">
      <span className="setup-card__icon" aria-hidden="true"><IdentificationCard size={22} weight="duotone" /></span>
      <div>
        <p className="eyebrow">GET STARTED</p>
        <h2>Create a grooming session</h2>
        <p>Use the appointment supplied by your salon.</p>
      </div>
    </div>
    <div className="setup-card__form">
      <label className="field-label" htmlFor="appointment-id">Appointment ID</label>
      <input id="appointment-id" autoComplete="off" value={props.appointmentId} onChange={event => props.setAppointmentId(event.target.value)} placeholder="Paste appointment ID" />
      <div className="setup-card__verification">
        {props.siteKey
          ? <TurnstileWidget siteKey={props.siteKey} onToken={props.setTurnstileToken} />
          : <p className="field-note">Session verification is not configured for this environment.</p>}
      </div>
      <button className="button button--primary button--wide" disabled={!props.turnstileToken || !props.appointmentId.trim() || props.state === "LOADING"} onClick={props.onCreate}>
        {props.state === "LOADING" ? "Creating secure session…" : "Create Session"}
      </button>
      <p className="field-note">Your session credential stays in memory and is never shown.</p>
      {props.error && <p className="inline-alert" role="alert">{props.error}</p>}
    </div>
  </section>;
}
