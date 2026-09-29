export type ReviewIntent =
  | { kind: "approve" }
  | { kind: "correct"; transcript: string }
  | { kind: "enter_correction" }
  | { kind: "repeat" }
  | { kind: "full_readback" }
  | { kind: "discard" }
  | { kind: "unknown" };

function normalize(text: string): string {
  return text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Client-side intent routing mirrors the conservative Python voice client; Worker state/revision checks remain mandatory. */
export function classifyReviewIntent(input: string): ReviewIntent {
  const text = normalize(input);
  if (!text) return { kind: "unknown" };

  if (/^(?:yes )?(?:approve(?: and save)?|approved|save(?: it| the note| this note)?|looks good|that s correct|that is correct)(?: please)?$/.test(text)) {
    return { kind: "approve" };
  }
  if (/^(?:discard(?: the note)?|cancel(?: this note)?|do not save(?: it| the note)?|dont save(?: it| the note)?)$/.test(text)) {
    return { kind: "discard" };
  }
  if (/^(?:repeat(?: that| the summary)?|say that again|say the summary again)$/.test(text)) {
    return { kind: "repeat" };
  }
  if (/^(?:read(?: the )?(?:full )?note|read everything|read the whole note)$/.test(text)) {
    return { kind: "full_readback" };
  }
  if (/^(?:correction|correct|change something|i need to correct that)$/.test(text)) {
    return { kind: "enter_correction" };
  }
  if (/^(?:correction|correct|change|actually|add|remove|replace)\s+\S+/.test(text)) {
    return { kind: "correct", transcript: input.trim() };
  }
  return { kind: "unknown" };
}
