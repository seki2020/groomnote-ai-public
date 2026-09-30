import type { FinalTurn } from "../stt/transcript";

// Only a complete terminal sentence is a control command. Quoted/embedded facts
// and natural provider turn boundaries cannot complete a report.
const finish = /(?:^|[.!?]\s+)(?:(?:okay|ok|well)[, ]+)?(?:that(?:'s| is) everything(?: for this groom)?|that(?:'s| is) all|i(?:'m| am) done|prepare my note|groomnote[, ]+finish)\s*[.!?]*$/i;

export function extractFinishCommand(text: string): { found: boolean; content: string } {
  const normalized = text.trim().replace(/[’‘]/g, "'");
  const match = finish.exec(normalized);
  return match ? { found: true, content: normalized.slice(0, match.index).trim() } : { found: false, content: text.trim() };
}

export function withoutFinishCommand(turn: FinalTurn): FinalTurn | null {
  const { content } = extractFinishCommand(turn.transcript);
  return content ? { ...turn, transcript: content } : null;
}

// Short confirmations are authorized only after the spoken silence question.
export function isPrepareConfirmation(text: string): boolean {
  return /^(?:prepare it|prepare my note|finish it|that's all|that is all|that's everything)[.!?]*$/i.test(text.trim().replace(/[’‘]/g, "'"));
}
