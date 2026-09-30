import type { BrowserSession } from "../api";
import { HalfDuplexGate } from "../audio/halfDuplex";
import { SpeechApiError, type SpeechApi, type SpeechAudio, type SpeechKind } from "./api";
import type { SpeechPlayer } from "./player";

export type TtsState = "IDLE" | "REQUESTING" | "DECODING" | "PLAYING" | "COMPLETED" | "STOPPING" | "ERROR";
export interface TtsTarget { kind: SpeechKind; identity: string }
export interface TtsSnapshot { state: TtsState; ready: boolean; error: string; current: TtsTarget | null; providerCalls: number }

export class TtsController {
  private value: TtsSnapshot = { state: "IDLE", ready: false, error: "", current: null, providerCalls: 0 };
  private cache = new Map<string, SpeechAudio>();
  private automatic = new Set<string>();
  private abort: AbortController | null = null;
  private busy = false;
  private disposed = false;
  constructor(
    private readonly session: BrowserSession,
    private readonly api: SpeechApi,
    private readonly player: SpeechPlayer,
    private readonly gate: HalfDuplexGate,
    private readonly notify: (snapshot: TtsSnapshot) => void,
  ) { this.value.ready = player.ready; }
  get snapshot() { return this.value; }
  private update(patch: Partial<TtsSnapshot>) { if (!this.disposed) { this.value = { ...this.value, ...patch }; this.notify(this.value); } }
  private key(target: TtsTarget) { return `${this.session.id}:${target.kind}:${target.identity}`; }

  async unlock(): Promise<void> {
    if (this.disposed) return;
    try { await this.player.unlock(); this.update({ ready: this.player.ready, error: "" }); }
    catch (error) { this.update({ ready: false, state: "ERROR", error: error instanceof Error ? error.message : "Browser audio could not be enabled." }); }
  }

  autoPlay(target: TtsTarget): void {
    const key = this.key(target);
    if (!this.player.ready) {
      if (this.value.ready) this.update({ ready: false, state: "ERROR", error: "Browser audio was suspended. Click Enable Voice to resume it." });
      return;
    }
    if (this.disposed || this.busy || this.gate.active || this.automatic.has(key)) return;
    this.automatic.add(key);
    void this.play(target);
  }

  async play(target: TtsTarget, automatic = false): Promise<void> {
    if (automatic) this.automatic.add(this.key(target));
    if (this.disposed || this.busy) return;
    if (!this.player.ready) { this.update({ ready: false, state: "ERROR", error: "Enable browser audio before playing speech." }); return; }
    if (!this.gate.acquire("tts")) { this.update({ state: "ERROR", error: "Finish microphone input before playing speech." }); return; }
    this.busy = true;
    const abort = new AbortController();
    this.abort = abort;
    this.update({ state: "REQUESTING", current: target, error: "" });
    try {
      const key = this.key(target);
      let audio = this.cache.get(key);
      if (!audio) {
        this.update({ providerCalls: this.value.providerCalls + 1 });
        audio = await this.api.getAudio(this.session, target.kind, abort.signal);
        if (abort.signal.aborted) throw new DOMException("Speech was stopped.", "AbortError");
        this.cache.set(key, audio);
      }
      this.update({ state: "DECODING" });
      try { await this.player.play(audio, abort.signal, () => this.update({ state: "PLAYING" })); }
      catch (error) {
        if (!abort.signal.aborted) this.cache.delete(key);
        throw error;
      }
      this.update({ state: "COMPLETED" });
    } catch (error) {
      if (abort.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) this.update({ state: "IDLE", error: "" });
      else this.update({ state: "ERROR", error: error instanceof SpeechApiError
        ? `${error.code} (${error.status}): ${error.message}`
        : error instanceof Error ? error.message : "Speech playback failed." });
    } finally {
      this.abort = null;
      this.busy = false;
      this.gate.release("tts");
    }
  }

  stop(): void {
    if (!this.busy) return;
    this.update({ state: "STOPPING" });
    this.abort?.abort();
    this.player.stop();
  }
  async dispose(): Promise<void> {
    this.stop();
    this.disposed = true;
    this.cache.clear();
    this.automatic.clear();
    await this.player.dispose();
    this.gate.release("tts");
  }
}
