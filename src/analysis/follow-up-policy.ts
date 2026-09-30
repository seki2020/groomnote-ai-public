import type { GroomingExtraction } from "./workers-ai";

/** Demo interaction policy: a consumed question never becomes another question.
 * Keep uncertainty in the note; completion is not proof that an answer is factual.
 */
export function applyFollowUpPolicy(extraction: GroomingExtraction, allowed: boolean): GroomingExtraction {
  if (allowed || !extraction.needs_follow_up) return extraction;
  return {
    ...extraction,
    needs_follow_up: false,
    follow_up_question: null,
    unresolved_items: [...new Set([
      ...extraction.unresolved_items,
      ...(extraction.follow_up_question ? [extraction.follow_up_question] : []),
    ])],
  };
}
