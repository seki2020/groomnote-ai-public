import type { BrowserSession } from "../api";

export type SpeechKind = "opening" | "follow_up" | "summary" | "save_confirmation";
export interface SpeechAudio { bytes: ArrayBuffer; contentType: "audio/wav" | "audio/mpeg" }

export class SpeechApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface SpeechApi {
  getAudio(session: BrowserSession, utterance: SpeechKind, signal: AbortSignal): Promise<SpeechAudio>;
}

export class HttpSpeechApi implements SpeechApi {
  private readonly fetcher: typeof fetch;
  constructor(private readonly baseUrl: string, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetcher;
  }
  async getAudio(session: BrowserSession, utterance: SpeechKind, signal: AbortSignal): Promise<SpeechAudio> {
    const response = await this.fetcher(`${this.baseUrl}/v1/sessions/${session.id}/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), utterance }),
      signal,
    });
    if (!response.ok) {
      let code = "HTTP_ERROR";
      let message = `Speech request failed (${response.status}).`;
      try {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object") {
          const error = body.error as Record<string, unknown>;
          if (typeof error.code === "string") code = error.code;
          if (typeof error.message === "string") message = error.message;
        }
      } catch { /* Status remains authoritative. */ }
      throw new SpeechApiError(response.status, code, message);
    }
    const rawType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
    if (rawType !== "audio/wav" && rawType !== "audio/mpeg") throw new Error("Speech response is not WAV or MP3 audio.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 8) throw new Error("Speech response contains no usable audio.");
    const head = new Uint8Array(bytes.slice(0, 12));
    const wav = rawType === "audio/wav" && head.length >= 12 && String.fromCharCode(...head.slice(0, 4)) === "RIFF" && String.fromCharCode(...head.slice(8, 12)) === "WAVE";
    const mp3 = rawType === "audio/mpeg" && ((head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0));
    if (!wav && !mp3) throw new Error("Speech response audio signature is invalid.");
    return { bytes, contentType: rawType };
  }
}
