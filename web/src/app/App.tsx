import { useEffect, useState } from "react";
import { apiBaseUrl, getHealth } from "../services/api";

export function App({ baseUrl = apiBaseUrl(import.meta.env.VITE_API_BASE_URL), fetcher = fetch }: { baseUrl?: string; fetcher?: typeof fetch }) {
  const [status, setStatus] = useState<"Checking..." | "Healthy" | "Unavailable">("Checking...");

  useEffect(() => {
    let active = true;
    getHealth(baseUrl, fetcher).then(
      () => { if (active) setStatus("Healthy"); },
      () => { if (active) setStatus("Unavailable"); },
    );
    return () => { active = false; };
  }, [baseUrl, fetcher]);

  return <main><h1>GroomNote Web Test</h1><p>Backend status: <span role="status">{status}</span></p><p>API URL: <code>{baseUrl}</code></p></main>;
}
