export interface FinalTurn { order: number; transcript: string }

export class TranscriptBuffer {
  private final = new Map<number, string>();
  private partial = new Map<number, string>();

  consume(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    if (message.type !== "Turn" || !Number.isInteger(message.turn_order) || (message.turn_order as number) < 0 || typeof message.transcript !== "string") return false;
    const order = message.turn_order as number;
    const transcript = message.transcript.trim();
    if (message.end_of_turn === true) {
      this.partial.delete(order);
      if (!transcript || this.final.has(order)) return false;
      this.final.set(order, transcript);
      return true;
    }
    if (!this.final.has(order)) this.partial.set(order, transcript);
    return false;
  }

  get finalTurns(): FinalTurn[] {
    return [...this.final].sort(([a], [b]) => a - b).map(([order, transcript]) => ({ order, transcript }));
  }

  get partialText(): string {
    return [...this.partial].sort(([a], [b]) => a - b).map(([, text]) => text).filter(Boolean).join(" ");
  }
}
