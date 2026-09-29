export type AudioOwner = "stt" | "tts";

/** Synchronous ownership prevents races before either provider starts asynchronous work. */
export class HalfDuplexGate {
  private owner: AudioOwner | null = null;
  get active(): AudioOwner | null { return this.owner; }
  acquire(owner: AudioOwner): boolean {
    if (this.owner !== null) return false;
    this.owner = owner;
    return true;
  }
  release(owner: AudioOwner): void {
    if (this.owner === owner) this.owner = null;
  }
}
