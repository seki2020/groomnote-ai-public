import type { DraftContent, ReviewDraft } from "../services/business/api";

const fields: { label: string; key: keyof DraftContent }[] = [
  { label: "Pet", key: "petName" },
  { label: "Breed", key: "breed" },
  { label: "Identity", key: "identityStatus" },
  { label: "Services completed", key: "servicesCompleted" },
  { label: "Services not completed", key: "servicesNotCompleted" },
  { label: "Grooming details", key: "groomingDetails" },
  { label: "Owner requests", key: "ownerRequests" },
  { label: "Observed behavior", key: "observedBehavior" },
  { label: "Behavior trigger", key: "behaviorTrigger" },
  { label: "Handling action", key: "handlingAction" },
  { label: "Observed outcome", key: "observedOutcome" },
  { label: "Next visit instructions", key: "nextVisitInstructions" },
  { label: "Unresolved items", key: "unresolvedItems" },
  { label: "Internal handover", key: "fullInternalHandover" },
];

export function DraftReview({ draft }: { draft: ReviewDraft }) {
  return <section aria-label="Structured draft">
    <h3>Structured Draft</h3>
    <dl>{fields.map(({ label, key }) => {
      const value = draft.content[key];
      const text = Array.isArray(value) ? value.join("; ") : value ?? "";
      return <div key={key}><dt>{label}</dt><dd>{text}</dd></div>;
    })}</dl>
    <p>Spoken Summary (text only): {draft.spokenSummary}</p>
    <p>Draft Revision: {draft.revision}</p>
  </section>;
}
