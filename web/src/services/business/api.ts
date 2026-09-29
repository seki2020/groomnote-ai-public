import type { BrowserSession } from "../api";

export type BusinessState = "COLLECTING" | "ANALYZING" | "AWAITING_FOLLOWUP" | "REVIEWING" | "AWAITING_APPROVAL" | "FAILED" | "CANCELLED" | "EXPIRED";
export interface SessionStatus { state: BusinessState; currentDraftRevision: number }
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

export class BusinessApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const states = new Set<BusinessState>(["COLLECTING", "ANALYZING", "AWAITING_FOLLOWUP", "REVIEWING", "AWAITING_APPROVAL", "FAILED", "CANCELLED", "EXPIRED"]);

export function parseDecision(value: unknown): AnalysisDecision {
  if (!record(value)) throw new Error("Malformed analysis response");
  if (value.action === "follow_up" && typeof value.question === "string" && value.question.trim()) return { action: "follow_up", question: value.question };
  if (value.action === "review" && revision(value.revision)) return { action: "review", revision: value.revision };
  throw new Error("Malformed analysis response");
}
export function parseSessionStatus(value: unknown): SessionStatus {
  if (!record(value) || typeof value.state !== "string" || !states.has(value.state as BusinessState) ||
      !Number.isSafeInteger(value.currentDraftRevision) || (value.currentDraftRevision as number) < 0) throw new Error("Malformed session state");
  return { state: value.state as BusinessState, currentDraftRevision: value.currentDraftRevision as number };
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
}
