import { useState } from "react";
import { createPublicSession, type BrowserSession } from "../services/api";

export function useBrowserSession(baseUrl: string, fetcher: typeof fetch) {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [state, setState] = useState<"IDLE" | "LOADING" | "READY" | "ERROR">("IDLE");
  const [error, setError] = useState("");
  async function create(appointmentId: string, turnstileToken: string) {
    if (state === "LOADING") return;
    setState("LOADING");
    setError("");
    try {
      const result = await createPublicSession(baseUrl, appointmentId, turnstileToken, fetcher);
      setSession(result);
      setState("READY");
    } catch {
      setState("ERROR");
      setError("Could not create session. Refresh verification and retry.");
    }
  }
  return { session, state, error, create };
}
