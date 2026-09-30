import type { BrowserSession } from "../api";

export type BusinessState = "COLLECTING" | "ANALYZING" | "AWAITING_FOLLOWUP" | "REVIEWING" | "AWAITING_APPROVAL" | "CORRECTING" | "SAVING" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";
export interface SessionStatus { question?: string; state: BusinessState; currentDraftRevision: number; reviewedRevision?: number | null; approvedRevision?: number | null }
export type AnalysisDecision = { action: "follow_up"; question: string } | { action: "review"; revision: number };
export interface DraftContent {
  petName: string;
  servicesCompleted: string[];
  nextVisitInstructions: string[];
  breed?: string | null;
  identityStatus?: "matched" | "ambiguous" | "unknown";
  servicesNotCompleted?: string[];
  groomingDetails?: string[];
  ownerRequests?: string[];
  observedBehavior?: string[];
  behaviorTrigger?: string[];
  handlingAction?: string[];
  observedOutcome?: string[];
  unresolvedItems?: string[];
  fullInternalHandover?: string;
}
export interface ReviewDraft { revision: number; content: DraftContent; spokenSummary: string }
export interface SavedNote { id: string; sessionId: string; revision: number; content: DraftContent }

export class BusinessApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const states = new Set<BusinessState>(["COLLECTING", "ANALYZING", "AWAITING_FOLLOWUP", "REVIEWING", "AWAITING_APPROVAL", "CORRECTING", "SAVING", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

export function parseDecision(value: unknown): AnalysisDecision {
  if (!record(value)) throw new Error("Malformed analysis response");
  if (value.action === "follow_up" && typeof value.question === "string" && value.question.trim()) return { action: "follow_up", question: value.question };
  if (value.action === "review" && revision(value.revision)) return { action: "review", revision: value.revision };
  throw new Error("Malformed analysis response");
}
export function parseSessionStatus(value: unknown): SessionStatus {
  if (!record(value) || typeof value.state !== "string" || !states.has(value.state as BusinessState) ||
      !Number.isSafeInteger(value.currentDraftRevision) || (value.currentDraftRevision as number) < 0) throw new Error("Malformed session state");
  const nullableRevision = (input: unknown) => input === null || input === undefined || (Number.isSafeInteger(input) && (input as number) > 0);
  if (!nullableRevision(value.reviewedRevision) || !nullableRevision(value.approvedRevision)) throw new Error("Malformed session revision status");
  return { question: typeof value.question === "string" ? value.question : undefined, state: value.state as BusinessState, currentDraftRevision: value.currentDraftRevision as number,
    reviewedRevision: typeof value.reviewedRevision === "number" ? value.reviewedRevision : null,
    approvedRevision: typeof value.approvedRevision === "number" ? value.approvedRevision : null };
}
export function parseReview(value: unknown): ReviewDraft {
  if (!record(value) || !revision(value.revision) || !record(value.content) || typeof value.spokenSummary !== "string" || !value.spokenSummary.trim()) throw new Error("Malformed review response");
  const content = value.content;
  if (typeof content.petName !== "string" || !content.petName.trim() || !strings(content.servicesCompleted) || !strings(content.nextVisitInstructions)) throw new Error("Malformed review response");
  const optionalLists = ["servicesNotCompleted", "groomingDetails", "ownerRequests", "observedBehavior", "behaviorTrigger", "handlingAction", "observedOutcome", "unresolvedItems"];
  if (optionalLists.some(key => content[key] !== undefined && !strings(content[key])) ||
      (content.breed !== undefined && content.breed !== null && typeof content.breed !== "string") ||
      (content.identityStatus !== undefined && !["matched", "ambiguous", "unknown"].includes(String(content.identityStatus))) ||
      (content.fullInternalHandover !== undefined && typeof content.fullInternalHandover !== "string")) throw new Error("Malformed review response");
  return value as unknown as ReviewDraft;
}

export interface BusinessApi {
  completeRound(session: BrowserSession): Promise<AnalysisDecision>;
  completeFollowUpRound(session: BrowserSession, roundId: string): Promise<AnalysisDecision>;
  getSession(session: BrowserSession): Promise<SessionStatus>;
  review(session: BrowserSession): Promise<ReviewDraft>;
  correct(session: BrowserSession, providerTurnId: string, transcript: string): Promise<AnalysisDecision>;
  approve(session: BrowserSession, revision: number): Promise<{ state: "COMPLETED"; noteId: string }>;
  cancel(session: BrowserSession): Promise<SessionStatus>;
  completeSttRound(session: BrowserSession, roundId: string): Promise<void>;
  closeSttRound(session: BrowserSession, roundId: string): Promise<void>;
  getNote(session: BrowserSession, noteId: string): Promise<SavedNote>;
}

export class HttpBusinessApi implements BusinessApi {
  private readonly fetcher: typeof fetch;
  constructor(private readonly baseUrl: string, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetcher;
  }
  private async request(session: BrowserSession, path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/v1/sessions/${session.id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${session.sessionToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let code = "HTTP_ERROR";
      let message = `Worker request failed (${response.status}).`;
      try {
        const value: unknown = await response.json();
        if (record(value) && record(value.error)) {
          if (typeof value.error.code === "string") code = value.error.code;
          if (typeof value.error.message === "string") message = value.error.message;
        }
      } catch { /* HTTP status remains authoritative. */ }
      throw new BusinessApiError(response.status, code, message);
    }
    return response.json();
  }
  async completeRound(session: BrowserSession) { return parseDecision(await this.request(session, "/complete-round", "POST", {})); }
  async completeFollowUpRound(session: BrowserSession, roundId: string) { return parseDecision(await this.request(session, "/complete-follow-up-round", "POST", { roundId })); }
  async getSession(session: BrowserSession) { return parseSessionStatus(await this.request(session, "", "GET")); }
  async review(session: BrowserSession) { return parseReview(await this.request(session, "/review", "POST", {})); }
  async correct(session: BrowserSession, providerTurnId: string, transcript: string) {
    return parseDecision(await this.request(session, "/correct", "POST", { providerTurnId, transcript }));
  }
  async approve(session: BrowserSession, revision: number) {
    const value = await this.request(session, "/approve", "POST", { revision });
    if (!record(value) || value.state !== "COMPLETED" || typeof value.noteId !== "string" || !/^([0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value.noteId)) {
      throw new Error("Malformed approval response");
    }
    return { state: "COMPLETED" as const, noteId: value.noteId };
  }
  async cancel(session: BrowserSession) {
    const status = parseSessionStatus(await this.request(session, "/cancel", "POST", {}));
    if (status.state !== "CANCELLED") throw new Error("Worker did not confirm cancellation");
    return status;
  }
  async completeSttRound(session: BrowserSession, roundId: string) {
    const value = await this.request(session, `/stt-rounds/${encodeURIComponent(roundId)}/complete`, "POST", {});
    if (!record(value) || value.status !== "COMPLETED") throw new Error("STT round was not completed");
  }
  async closeSttRound(session: BrowserSession, roundId: string) {
    const value = await this.request(session, `/stt-rounds/${encodeURIComponent(roundId)}/close`, "POST", {});
    if (!record(value) || !["COMPLETED", "FAILED"].includes(String(value.status))) throw new Error("STT round could not be closed");
  }
  async getNote(session: BrowserSession, noteId: string): Promise<SavedNote> {
    const response = await this.fetcher(`${this.baseUrl}/v1/notes/${encodeURIComponent(noteId)}?sessionId=${encodeURIComponent(session.id)}`, {
      method: "GET", headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    if (!response.ok) {
      let code = "HTTP_ERROR";
      let message = `Worker request failed (${response.status}).`;
      try {
        const body: unknown = await response.json();
        if (record(body) && record(body.error)) {
          if (typeof body.error.code === "string") code = body.error.code;
          if (typeof body.error.message === "string") message = body.error.message;
        }
      } catch { /* The status remains authoritative. */ }
      throw new BusinessApiError(response.status, code, message);
    }
    const value: unknown = await response.json();
    if (!record(value) || typeof value.id !== "string" || typeof value.sessionId !== "string" || !revision(value.revision) || !record(value.content)) {
      throw new Error("Malformed saved note response");
    }
    const parsedContent = parseReview({ revision: value.revision, content: value.content, spokenSummary: "saved-note-validation" }).content;
    return { id: value.id, sessionId: value.sessionId, revision: value.revision, content: parsedContent };
  }
}

export function sameDraftContent(left: DraftContent, right: DraftContent): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
