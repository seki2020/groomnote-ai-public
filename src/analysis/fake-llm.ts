import type { HandoverContent } from "../persistence/schemas";

export type FakeAnalysis =
  | { kind: "follow_up"; question: string }
  | { kind: "draft"; content: HandoverContent; spokenSummary: string };

export function analyzeDeterministically(input: {
  petName: string;
  transcripts: readonly string[];
  hasFollowUpAnswer: boolean;
}): FakeAnalysis { throw new Error("PRIVATE_DEMO_ANALYZER_NOT_INCLUDED"); }
