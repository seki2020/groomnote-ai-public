import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import type { BrowserSession } from "../services/api";
import type { SavedNote } from "../services/business/api";
import { DraftReview } from "./DraftReview";

export function SavedCompletion({ session, note, speechError = "" }: { session: BrowserSession; note: SavedNote; speechError?: string }) {
  const petIsBella = note.content.petName.trim().toLowerCase() === "bella";
  return <section className="completion-layout" aria-label="Verified saved note" data-testid="saved-note">
    <article className="saved-report panel">
      <header className="saved-report__header">
        {petIsBella && <figure className="pet-illustration">
          <img src="/assets/bella-portrait.svg" alt="Illustration of a golden retriever, not a photograph of this pet" />
          <figcaption>Illustrative portrait</figcaption>
        </figure>}
        <div>
          <p className="eyebrow">GROOMING HANDOVER</p>
          <h2>{note.content.petName}&rsquo;s report</h2>
          {note.content.breed && <p className="saved-report__breed">{note.content.breed}</p>}
        </div>
        <span className="verified-badge"><CheckCircle size={19} weight="fill" aria-hidden="true" /> VERIFIED</span>
      </header>
      <DraftReview draft={{ revision: note.revision, content: note.content, spokenSummary: "" }} variant="saved" />
    </article>

    <aside className="completion-confirmation" aria-label="Save confirmation">
      <div className="completion-confirmation__icon"><CheckCircle size={44} weight="fill" aria-hidden="true" /></div>
      <p className="eyebrow">ALL DONE</p>
      <h2>COMPLETED — persistence verified</h2>
      <p className="completion-confirmation__title">Handover saved</p>
      <span className="visually-hidden">Saved Revision: {note.revision}</span>
      <p className="completion-confirmation__copy">Your grooming note was saved and retrieved successfully.</p>
      <dl className="save-receipt">
        <div><dt>Saved Revision</dt><dd>{note.revision}</dd></div>
        <div><dt>Note ID</dt><dd data-testid="saved-note-id">{note.id}</dd></div>
        <div><dt>Session</dt><dd>{session.id}</dd></div>
        <div><dt>Persistence</dt><dd><span className="receipt-status"><CheckCircle size={16} weight="fill" aria-hidden="true" /> VERIFIED</span></dd></div>
      </dl>
      <p className="visually-hidden">Persistence: VERIFIED</p>
      {speechError && <p role="alert" className="inline-alert">Note is saved. Success speech failed: {speechError}</p>}
    </aside>
  </section>;
}
