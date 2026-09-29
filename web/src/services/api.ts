export interface HealthResponse {
  status: "ok";
  service: "groomnote-ai";
  environment: string;
}

export interface BrowserSession {
  id: string;
  sessionToken: string;
  state: "COLLECTING";
  openingPrompt: string;
}

export async function createPublicSession(baseUrl: string, appointmentId: string, turnstileToken: string, fetcher: typeof fetch = fetch): Promise<BrowserSession> {
  const response = await fetcher(`${baseUrl}/v1/public/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId, turnstileToken }),
  });
  if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Malformed session response");
  const session = value as Partial<BrowserSession>;
  if (typeof session.id !== "string" || !/^[0-9a-f-]{36}$/i.test(session.id) ||
      typeof session.sessionToken !== "string" || session.sessionToken.length < 32 ||
      session.state !== "COLLECTING" || typeof session.openingPrompt !== "string") {
    throw new Error("Malformed session response");
  }
  return session as BrowserSession;
}

export function apiBaseUrl(value: string | undefined): string {
  const input = value?.trim() || "/api";
  if (input.startsWith("/")) {
    if (input.startsWith("//") || !/^\/[\w/-]*$/.test(input)) throw new Error("Invalid API base URL");
    return input.replace(/\/$/, "") || "/";
  }
  const url = new URL(input);
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid API base URL");
  }
  return url.href.replace(/\/$/, "");
}

export async function getHealth(baseUrl: string, fetcher: typeof fetch = fetch): Promise<HealthResponse> {
  const response = await fetcher(`${baseUrl}/health`, { method: "GET" });
  if (!response.ok) throw new Error("Backend unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Malformed health response");
  const health = value as Partial<HealthResponse>;
  if (health.status !== "ok" || health.service !== "groomnote-ai" || typeof health.environment !== "string") {
    throw new Error("Malformed health response");
  }
  return health as HealthResponse;
}
