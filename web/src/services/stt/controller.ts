import type { BrowserSession } from "../api";
import type { Microphone } from "../audio/types";
import type { HalfDuplexGate } from "../audio/halfDuplex";
import { TranscriptBuffer, type FinalTurn } from "./transcript";
import type { SttWorkerApi, TemporarySttToken } from "./workerApi";

export type SttState = "IDLE" | "REQUESTING_MIC" | "REQUESTING_TOKEN" | "CONNECTING" | "LISTENING" | "FINALIZING" | "CLOSED" | "ERROR";
export type SttCaptureMode = "business" | "review" | "correction";
export interface SttSnapshot {
  state: SttState;
  microphone: string;
  partial: string;
  finalTurns: FinalTurn[];
  persisted: number;
  completedRoundId: string | null;
  round: "NONE" | "OPEN" | "CLOSED";
  error: string;
  captureMode: SttCaptureMode;
  capturedText: string;
}

export interface SocketLike {
  readyState: 0 | 1 | 2 | 3;
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;
const OPEN = 1;
const TERMINATION_WAIT_MS = 6_000;

export function assemblyAiUrl(credentials: TemporarySttToken): string {
  const url = new URL(credentials.websocketUrl);
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("speech_model", "universal-3-6-pro");
  url.searchParams.set("min_turn_silence", "200");
  url.searchParams.set("max_turn_silence", "2000");
  url.searchParams.set("language_codes", JSON.stringify(["en"]));
  url.searchParams.set("keyterms_prompt", JSON.stringify([]));
  url.searchParams.set("token", credentials.token);
  return url.toString();
}

export class SttController {
  private snapshotValue: SttSnapshot = { state: "IDLE", microphone: "", partial: "", finalTurns: [], persisted: 0, completedRoundId: null, round: "NONE", error: "", captureMode: "business", capturedText: "" };
  private transcript = new TranscriptBuffer();
  private microphone: Microphone | null = null;
  private socket: SocketLike | null = null;
  private roundId: string | null = null;
  private finishRequested = false;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private finishTask: Promise<void> | null = null;
  private terminateResolve: (() => void) | null = null;
  private terminateReject: ((error: Error) => void) | null = null;
  private terminated = false;
  private captureMode: SttCaptureMode = "business";

  constructor(
    private readonly session: BrowserSession,
    private readonly api: SttWorkerApi,
    private readonly microphoneFactory: () => Promise<Microphone>,
    private readonly socketFactory: SocketFactory,
    private readonly notify: (snapshot: SttSnapshot) => void,
    private readonly audioGate?: HalfDuplexGate,
  ) {}

  get snapshot(): SttSnapshot { return this.snapshotValue; }

  private update(patch: Partial<SttSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.notify(this.snapshotValue);
  }

  async start(mode: SttCaptureMode = "business"): Promise<void> {
    if (!["IDLE", "CLOSED", "ERROR"].includes(this.snapshotValue.state)) return;
    if (this.roundId) {
      this.update({ state: "ERROR", error: "Finish or discard the previous voice action before starting another round." });
      return;
    }
    if (this.audioGate && !this.audioGate.acquire("stt")) {
      this.update({ state: "ERROR", error: "Stop speech playback before starting the microphone." });
      return;
    }
    this.finishRequested = false;
    this.captureMode = mode;
    this.terminated = false;
    this.transcript = new TranscriptBuffer();
    this.update({ state: "REQUESTING_MIC", partial: "", finalTurns: [], capturedText: "", captureMode: mode, persisted: 0, completedRoundId: null, round: "NONE", error: "" });
    try {
      this.microphone = await this.microphoneFactory();
      this.update({ microphone: this.microphone.label });
      if (this.finishRequested) { await this.release(); this.update({ state: "CLOSED" }); return; }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.connectOnce();
          return;
        } catch {
          await this.abandonRound();
          this.socket?.close();
          this.socket = null;
          if (this.finishRequested) { await this.release(); this.update({ state: "CLOSED" }); return; }
          if (attempt === 1) throw new Error("Could not connect to transcription service.");
        }
      }
    } catch (error) {
      await this.release();
      this.update({ state: "ERROR", error: error instanceof Error ? error.message : "Transcription failed." });
    }
  }

  private async connectOnce(): Promise<void> {
    this.update({ state: "REQUESTING_TOKEN" });
    const credentials = await this.api.issueToken(this.session);
    this.roundId = credentials.roundId;
    this.update({ state: "CONNECTING", round: "OPEN" });
    await new Promise<void>((resolve, reject) => {
      let begun = false;
      const socket = this.socketFactory(assemblyAiUrl(credentials));
      this.socket = socket;
      const handshakeTimer = setTimeout(() => {
        if (!begun) {
          socket.close();
          reject(new Error("Transcription token redemption timed out."));
        }
      }, Math.min(4_500, credentials.expiresInSeconds * 1_000));
      socket.onmessage = event => {
        let message: unknown;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message || typeof message !== "object") return;
        const data = message as Record<string, unknown>;
        if (data.type === "Begin" && !begun) {
          begun = true;
          clearTimeout(handshakeTimer);
          this.update({ state: "LISTENING" });
          this.microphone?.startSending(chunk => { if (socket.readyState === OPEN && ["LISTENING", "FINALIZING"].includes(this.snapshotValue.state)) socket.send(chunk); });
          this.capTimer = setTimeout(() => { void this.finish(); }, credentials.maxSessionDurationSeconds * 1000);
          resolve();
          if (this.finishRequested) void this.finish();
        } else if (data.type === "Turn" && begun && !["CLOSED", "ERROR"].includes(this.snapshotValue.state)) {
          this.transcript.consume(data);
          this.update({ partial: this.transcript.partialText, finalTurns: this.transcript.finalTurns });
        } else if (data.type === "Termination") {
          this.terminated = true;
          this.terminateResolve?.();
        } else if (data.type === "Error" || data.type === "SessionError") {
          const error = new Error("Transcription provider error.");
          if (!begun) { clearTimeout(handshakeTimer); reject(error); }
          else if (this.snapshotValue.state === "LISTENING") void this.failConnected();
          else this.terminateReject?.(error);
        }
      };
      socket.onerror = () => {
        if (!begun) { clearTimeout(handshakeTimer); reject(new Error("Transcription connection failed.")); }
        else if (this.snapshotValue.state === "LISTENING") void this.failConnected();
        else this.terminateReject?.(new Error("Transcription connection failed."));
      };
      socket.onclose = () => {
        if (!begun) { clearTimeout(handshakeTimer); reject(new Error("Transcription connection closed.")); }
        else if (!this.terminated && this.snapshotValue.state === "FINALIZING") this.terminateReject?.(new Error("Transcription ended before finalization."));
        else if (!this.terminated && this.snapshotValue.state === "LISTENING") void this.failConnected();
      };
    });
  }

  async finish(transform?: (turn: FinalTurn) => FinalTurn | null): Promise<void> {
    if (this.snapshotValue.state === "CONNECTING" || this.snapshotValue.state === "REQUESTING_MIC" || this.snapshotValue.state === "REQUESTING_TOKEN") {
      this.finishRequested = true;
      return;
    }
    if (this.snapshotValue.state !== "LISTENING") return this.finishTask ?? Promise.resolve();
    if (this.finishTask) return this.finishTask;
    this.finishTask = this.finishConnected(transform);
    try { await this.finishTask; } finally { this.finishTask = null; }
  }

  private async finishConnected(transform?: (turn: FinalTurn) => FinalTurn | null): Promise<void> {
    this.update({ state: "FINALIZING" });
    if (this.capTimer) clearTimeout(this.capTimer);
    this.microphone?.stopSending();
    try {
      if (!this.socket || this.socket.readyState !== OPEN || !this.roundId) throw new Error("Transcription connection is unavailable.");
      const termination = new Promise<void>((resolve, reject) => { this.terminateResolve = resolve; this.terminateReject = reject; });
      this.socket.send(JSON.stringify({ type: "Terminate" }));
      await Promise.race([termination, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Transcription finalization timed out.")), TERMINATION_WAIT_MS))]);
      const completedRoundId = this.roundId;
      const finalTurns = transform ? this.transcript.finalTurns.map(transform).filter((turn): turn is FinalTurn => turn !== null) : this.transcript.finalTurns;
      const capturedText = finalTurns.map(turn => turn.transcript).join(" ").trim();
      if (this.captureMode === "business") {
        for (const turn of finalTurns) {
          await this.api.addTurn(this.session, `${completedRoundId}:${turn.order}`, turn.transcript);
          this.update({ persisted: this.snapshotValue.persisted + 1 });
        }
        await this.api.completeConnection(this.session, completedRoundId);
        this.roundId = null;
      }
      this.update({ state: "CLOSED", round: this.captureMode === "business" ? "CLOSED" : "OPEN", completedRoundId, capturedText, finalTurns, partial: "" });
    } catch (error) {
      await this.abandonRound();
      this.update({ state: "ERROR", error: error instanceof Error ? error.message : "Transcription finalization failed." });
    } finally {
      await this.release();
    }
  }

  async completeBufferedCapture(): Promise<void> {
    const id = this.roundId;
    if (!id || this.captureMode === "business" || this.snapshotValue.state !== "CLOSED") return;
    await this.api.completeConnection(this.session, id);
    this.roundId = null;
    this.update({ round: "CLOSED" });
  }

  acknowledgeBufferedCaptureConsumed(roundId: string): void {
    if (this.roundId !== roundId || this.captureMode === "business") return;
    this.roundId = null;
    this.update({ round: "CLOSED" });
  }

  async discardBufferedCapture(): Promise<void> {
    if (!this.roundId || this.captureMode === "business") return;
    await this.abandonRound();
    this.update({ state: "CLOSED", round: "CLOSED" });
  }

  private async failConnected() {
    if (this.snapshotValue.state !== "LISTENING") return;
    await this.abandonRound();
    await this.release();
    this.update({ state: "ERROR", error: "Transcription connection closed unexpectedly." });
  }

  private async abandonRound() {
    if (!this.roundId) return;
    const id = this.roundId;
    this.roundId = null;
    try { await this.api.closeConnection(this.session, id); } catch { /* Preserve original failure. */ }
    this.update({ round: "CLOSED" });
  }

  private async release() {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    this.socket?.close();
    this.socket = null;
    await this.microphone?.release();
    this.microphone = null;
    this.terminateResolve = null;
    this.terminateReject = null;
    this.audioGate?.release("stt");
  }

  async dispose(): Promise<void> {
    this.finishRequested = true;
    this.update({ state: "CLOSED", round: "CLOSED" });
    await this.abandonRound();
    await this.release();
  }
}
