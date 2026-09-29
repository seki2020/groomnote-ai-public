import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { Scissors } from "@phosphor-icons/react/dist/csr/Scissors";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import type { DraftContent, ReviewDraft } from "../services/business/api";

const readValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).join("; ");
  return typeof value === "string" ? value.trim() : "";
};

function DataRow({ label, value, accent = false }: { label: string; value: unknown; accent?: boolean }) {
  const text = readValue(value);
  if (!text) return null;
  return <div className={`draft-row${accent ? " draft-row--accent" : ""}`}>
    <dt>{label}</dt>
    <dd data-testid={label === "Services completed" ? "services-completed" : undefined}>{text}</dd>
  </div>;
}

export function DraftReview({ draft, variant = "review" }: { draft: ReviewDraft; variant?: "review" | "saved" }) {
  const content: DraftContent = draft.content;
  const saved = variant === "saved";
  const unresolved = readValue(content.unresolvedItems);
  return <section className={`draft-review${saved ? " draft-review--saved" : ""}`} aria-label={saved ? "Persisted structured note" : "Structured draft"}>
    <header className="draft-review__header">
      <div>
        <p className="eyebrow">{saved ? "SAVED HANDOVER" : "CURRENT REVIEW"}</p>
        <h3>Structured Draft</h3>
      </div>
      <span className="revision-pill">Draft Revision: {draft.revision}</span>
    </header>

    <dl className="draft-facts">
      <div className="draft-fact-card draft-fact-card--pet">
        <dt>Pet</dt><dd>{content.petName}</dd>
        {content.breed?.trim() && <span className="draft-fact-card__detail">{content.breed}</span>}
        {content.identityStatus && <span className={`identity-label identity-label--${content.identityStatus}`}>Identity {content.identityStatus}</span>}
      </div>
      <div className="draft-fact-card">
        <dt><Scissors size={17} weight="duotone" aria-hidden="true" /> Grooming</dt>
        <DataRow label="Services completed" value={content.servicesCompleted} accent />
        <DataRow label="Services not completed" value={content.servicesNotCompleted} />
        <DataRow label="Additional details" value={content.groomingDetails} />
        <DataRow label="Owner requests" value={content.ownerRequests} />
      </div>
      <div className="draft-fact-card">
        <dt>Behavior &amp; handling</dt>
        <DataRow label="Observed behavior" value={content.observedBehavior} />
        <DataRow label="Trigger" value={content.behaviorTrigger} />
        <DataRow label="Handling" value={content.handlingAction} />
        <DataRow label="Outcome" value={content.observedOutcome} />
      </div>
      <div className="draft-fact-card draft-fact-card--next">
        <dt><CalendarBlank size={17} weight="duotone" aria-hidden="true" /> Next visit</dt>
        <dd>{readValue(content.nextVisitInstructions) || <span className="muted-value">No specific instruction recorded</span>}</dd>
      </div>
      {unresolved && <div className="draft-fact-card draft-fact-card--unresolved">
        <dt><WarningCircle size={17} weight="duotone" aria-hidden="true" /> Needs attention</dt>
        <dd>{unresolved}</dd>
      </div>}
    </dl>

    {readValue(content.fullInternalHandover) && <details className="handover-detail">
      <summary>Read full handover text</summary>
      <p>{content.fullInternalHandover}</p>
    </details>}
    {!saved && <p className="spoken-summary">Spoken Summary (text only): {draft.spokenSummary}</p>}
  </section>;
}
