import type { BrowserSession } from "../api";

export interface TemporarySttToken {
  token: string;
  roundId: string;
  expiresInSeconds: number;
  maxSessionDurationSeconds: number;
  websocketUrl: string;
}

export interface SttWorkerApi {
  issueToken(session: BrowserSession): Promise<TemporarySttToken>;
  addTurn(session: BrowserSession, providerTurnId: string, transcript: string): Promise<void>;
  completeConnection(session: BrowserSession, roundId: string): Promise<void>;
  closeConnection(session: BrowserSession, roundId: string): Promise<void>;
}

export class HttpSttWorkerApi implements SttWorkerApi {
  private readonly fetcher: typeof fetch;
  constructor(private readonly baseUrl: string, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher === globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetcher;
  }

  private async post(session: BrowserSession, path: string, body: unknown): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/v1/sessions/${session.id}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`STT Worker request failed (${response.status})`);
    return response.json();
  }

  async issueToken(session: BrowserSession): Promise<TemporarySttToken> {
    const value = await this.post(session, "/stt-token", {});
    if (!value || typeof value !== "object") throw new Error("Malformed STT token response");
    const result = value as Partial<TemporarySttToken>;
    if (typeof result.token !== "string" || !result.token || typeof result.roundId !== "string" ||
        typeof result.websocketUrl !== "string" || result.websocketUrl !== "wss://streaming.assemblyai.com/v3/ws" ||
        result.expiresInSeconds !== 5 || !Number.isFinite(result.maxSessionDurationSeconds) ||
        result.maxSessionDurationSeconds! < 1 || result.maxSessionDurationSeconds! > 240) {
      throw new Error("Malformed STT token response");
    }
    return result as TemporarySttToken;
  }

  async addTurn(session: BrowserSession, providerTurnId: string, transcript: string): Promise<void> {
    await this.post(session, "/turns", { providerTurnId, transcript });
  }
  async completeConnection(session: BrowserSession, roundId: string): Promise<void> {
    await this.post(session, `/stt-rounds/${roundId}/complete`, {});
  }
  async closeConnection(session: BrowserSession, roundId: string): Promise<void> {
    await this.post(session, `/stt-rounds/${roundId}/close`, {});
  }
}
