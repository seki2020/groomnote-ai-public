import { ApiError } from "./errors";
import { cleanupExpiredSessions } from "../security/session";

export function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHORIZED", "A bearer credential is required.");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new ApiError(401, "UNAUTHORIZED", "A bearer credential is required.");
  return token;
}

export async function hashCredential(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function requireDemoCredential(request: Request, expected: string): Promise<void> {
  const supplied = bearerToken(request);
  if (!expected || supplied !== expected) {
    throw new ApiError(401, "UNAUTHORIZED", "The development API credential is invalid.");
  }
}

export async function requireSessionCredential(
  db: D1Database,
  request: Request,
  sessionId: string,
): Promise<void> {
  const suppliedHash = await hashCredential(bearerToken(request));
  const row = await db
    .prepare("SELECT id FROM sessions WHERE id = ? AND session_token_hash = ?")
    .bind(sessionId, suppliedHash)
    .first<{ id: string }>();
  if (!row) throw new ApiError(403, "SESSION_FORBIDDEN", "The session credential is invalid.");
  const session = await db.prepare(
    "SELECT expires_at AS expiresAt FROM sessions WHERE id = ?",
  ).bind(sessionId).first<{ expiresAt: string }>();
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    await cleanupExpiredSessions(db);
    throw new ApiError(409, "SESSION_EXPIRED", "The session has expired.");
  }
}
