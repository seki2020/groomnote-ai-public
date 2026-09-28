import { z } from "zod";

export const ASSEMBLYAI_TOKEN_ENDPOINT = "https://streaming.assemblyai.com/v3/token";
export const ASSEMBLYAI_WEBSOCKET_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
export const TOKEN_EXPIRES_IN_SECONDS = 5;
export const MAX_SESSION_DURATION_SECONDS = 240;

const tokenResponseSchema = z.object({ token: z.string().min(1) });

export interface TokenProvider {
  createToken(): Promise<string>;
}

export class AssemblyAITokenProvider implements TokenProvider {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly apiKey: string,
    fetcher?: typeof fetch,
  ) {
    if (!apiKey) throw new Error("AssemblyAI is not configured.");
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async createToken(): Promise<string> {
    const url = new URL(ASSEMBLYAI_TOKEN_ENDPOINT);
    url.searchParams.set("expires_in_seconds", String(TOKEN_EXPIRES_IN_SECONDS));
    url.searchParams.set("max_session_duration_seconds", String(MAX_SESSION_DURATION_SECONDS));
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { Authorization: this.apiKey },
    });
    if (!response.ok) throw new Error(`AssemblyAI token request failed with HTTP ${response.status}.`);
    return tokenResponseSchema.parse(await response.json()).token;
  }
}

export class FakeTokenProvider implements TokenProvider {
  async createToken(): Promise<string> {
    return "stage-06-temporary-token";
  }
}

export class FailingTokenProvider implements TokenProvider {
  async createToken(): Promise<string> {
    throw new Error("Controlled provider failure.");
  }
}
