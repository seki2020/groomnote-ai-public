export type Bindings = {
  APP_ENV: string;
  ANALYZER_MODE: "fake" | "fake-error" | "workers-ai";
  TTS_MODE: "fake" | "fake-wav" | "fake-error" | "workers-ai";
  STT_TOKEN_MODE: "fake" | "fake-error" | "assemblyai";
  ASSEMBLYAI_API_KEY?: string;
  DEMO_API_KEY: string;
  CORS_ALLOWED_ORIGIN?: string;
  TURNSTILE_SECRET_KEY?: string;
  AI: Ai;
  DB: D1Database;
};
