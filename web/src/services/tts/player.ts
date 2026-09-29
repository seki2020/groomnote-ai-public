import type { SpeechAudio } from "./api";

export interface SpeechPlayer {
  readonly ready: boolean;
  unlock(): Promise<void>;
  play(audio: SpeechAudio, signal: AbortSignal, onPlaying: () => void): Promise<void>;
  stop(): void;
  dispose(): Promise<void>;
}

export class WebAudioPlayer implements SpeechPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private rejectPlayback: ((error: Error) => void) | null = null;
  get ready() { return this.context?.state === "running"; }

  async unlock(): Promise<void> {
    // Construct/resume during the caller's real click handler, before any network await.
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") await this.context.resume();
    if (this.context.state !== "running") throw new Error("Browser audio could not be enabled. Click Enable Voice again.");
  }

  async play(audio: SpeechAudio, signal: AbortSignal, onPlaying: () => void): Promise<void> {
    if (!this.context || this.context.state !== "running") throw new Error("Enable browser audio before playing speech.");
    if (this.source) throw new Error("Speech playback is already active.");
    if (signal.aborted) throw new DOMException("Speech was stopped.", "AbortError");
    const decoded = await this.context.decodeAudioData(audio.bytes.slice(0));
    if (!decoded.length || !decoded.duration) throw new Error("Speech audio could not be decoded.");
    if (signal.aborted) throw new DOMException("Speech was stopped.", "AbortError");
    const source = this.context.createBufferSource();
    source.buffer = decoded;
    source.connect(this.context.destination);
    this.source = source;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        source.onended = null;
        signal.removeEventListener("abort", abort);
        source.disconnect();
        if (this.source === source) this.source = null;
        this.rejectPlayback = null;
      };
      const settle = (error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const abort = () => { try { source.stop(); } catch { /* Already stopped. */ } settle(new DOMException("Speech was stopped.", "AbortError")); };
      this.rejectPlayback = settle;
      source.onended = () => settle();
      signal.addEventListener("abort", abort, { once: true });
      try { source.start(); onPlaying(); }
      catch (error) { settle(error instanceof Error ? error : new Error("Speech playback failed.")); }
    });
  }

  stop() { const source = this.source; try { source?.stop(); } catch { /* Already stopped. */ } this.rejectPlayback?.(new DOMException("Speech was stopped.", "AbortError")); }
  async dispose() { this.stop(); const context = this.context; this.context = null; if (context && context.state !== "closed") await context.close(); }
}
