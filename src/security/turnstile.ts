import { ApiError } from "../api/errors";

interface SiteverifyResult {
  success?: boolean;
  hostname?: string;
  action?: string;
}

export async function verifyTurnstile(
  token: string,
  secret: string | undefined,
  expectedOrigin: string,
  fetcher: typeof fetch = fetch,
  allowOfficialTestSecret = false,
): Promise<void> {
  if (!secret) throw new ApiError(503, "TURNSTILE_UNAVAILABLE", "Browser verification is unavailable.");
  const usingOfficialTestSecret = secret === "1x0000000000000000000000000000000AA";
  if (usingOfficialTestSecret && !allowOfficialTestSecret) {
    throw new ApiError(503, "TURNSTILE_UNAVAILABLE", "Browser verification is unavailable.");
  }
  if (!token || token.length > 2048) throw new ApiError(422, "VALIDATION_ERROR", "The verification token is invalid.");
  const body = new URLSearchParams({ secret, response: token });
  let result: SiteverifyResult;
  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("siteverify HTTP failure");
    result = (await response.json()) as SiteverifyResult;
  } catch {
    throw new ApiError(503, "TURNSTILE_UNAVAILABLE", "Browser verification is unavailable.");
  }
  if (!result.success) throw new ApiError(403, "TURNSTILE_REJECTED", "Browser verification failed.");
  // The official dummy token currently returns example.com and no action from live Siteverify.
  // Only non-production Workers explicitly opting into that public test secret may use it.
  if (usingOfficialTestSecret) return;
  const hostname = new URL(expectedOrigin).hostname;
  if (result.hostname !== hostname) {
    throw new ApiError(403, "TURNSTILE_REJECTED", "Browser verification failed.");
  }
  if (result.action !== "create_session") {
    throw new ApiError(403, "TURNSTILE_REJECTED", "Browser verification failed.");
  }
}
