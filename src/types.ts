export type Bindings = {
  APP_ENV: string;
  HACKATHON_MODE?: string;
  ANALYZER_MODE: "fake" | "fake-error" | "workers-ai";
  TTS_MODE: "fake" | "fake-wav" | "fake-error" | "workers-ai";
  STT_TOKEN_MODE: "fake" | "fake-error" | "assemblyai";
  DEV_STT_SESSION_TOKEN_ISSUANCE_LIMIT?: string;
  DEV_STT_DAILY_TOKEN_ISSUANCE_LIMIT?: string;
  ASSEMBLYAI_API_KEY?: string;
  DEMO_API_KEY: string;
  CORS_ALLOWED_ORIGIN?: string;
  TURNSTILE_SECRET_KEY?: string;
  AI: Ai;
  DB: D1Database;
};
