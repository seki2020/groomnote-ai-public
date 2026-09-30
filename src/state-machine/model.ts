export const sessionStates = [
  "CREATED",
  "OPENING",
  "COLLECTING",
  "ANALYZING",
  "AWAITING_FOLLOWUP",
  "REVIEWING",
  "AWAITING_APPROVAL",
  "CORRECTING",
  "SAVING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
] as const;

export type SessionState = (typeof sessionStates)[number];

export type SessionSnapshot = {
  state: SessionState;
  currentDraftRevision: number;
  reviewedRevision: number | null;
  approvedRevision: number | null;
};

export const permittedTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  CREATED: ["OPENING", "CANCELLED", "FAILED", "EXPIRED"],
  OPENING: ["COLLECTING", "CANCELLED", "FAILED", "EXPIRED"],
  COLLECTING: ["ANALYZING", "CANCELLED", "FAILED", "EXPIRED"],
  ANALYZING: ["AWAITING_FOLLOWUP", "REVIEWING", "FAILED", "EXPIRED"],
  AWAITING_FOLLOWUP: ["COLLECTING", "ANALYZING", "CANCELLED", "FAILED", "EXPIRED"],
  REVIEWING: ["AWAITING_APPROVAL", "CORRECTING", "CANCELLED", "FAILED", "EXPIRED"],
  AWAITING_APPROVAL: ["SAVING", "CORRECTING", "CANCELLED", "FAILED", "EXPIRED"],
  CORRECTING: ["REVIEWING", "AWAITING_FOLLOWUP", "CANCELLED", "FAILED", "EXPIRED"],
  SAVING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
  EXPIRED: [],
};

export function isTransitionAllowed(from: SessionState, to: SessionState): boolean {
  return permittedTransitions[from].includes(to);
}

export function assertApprovalEligible(
  session: SessionSnapshot,
  requestedRevision: number,
): void {
  if (session.state !== "AWAITING_APPROVAL") {
    throw new Error("Session is not awaiting approval.");
  }
  if (
    session.currentDraftRevision < 1 ||
    session.reviewedRevision !== session.currentDraftRevision ||
    requestedRevision !== session.currentDraftRevision
  ) {
    throw new Error("Approval does not match the latest reviewed draft.");
  }
}

export function invalidateApprovalForCorrection(
  session: SessionSnapshot,
): SessionSnapshot {
  if (session.state !== "AWAITING_APPROVAL") {
    throw new Error("Only a reviewed draft can enter correction.");
  }
  return {
    ...session,
    state: "CORRECTING",
    reviewedRevision: null,
    approvedRevision: null,
  };
}

export function canAcceptTranscriptTurns(state: SessionState): boolean {
  return state === "COLLECTING";
}

export function canPersistFromState(state: SessionState): boolean {
  return state === "SAVING";
}

