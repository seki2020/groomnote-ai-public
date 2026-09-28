export type Bindings = {
  APP_ENV: string;
  ANALYZER_MODE: "fake" | "workers-ai";
  TTS_MODE: "fake" | "workers-ai";
  STT_TOKEN_MODE: "fake" | "fake-error" | "assemblyai";
  ASSEMBLYAI_API_KEY?: string;
  DEMO_API_KEY: string;
  CORS_ALLOWED_ORIGIN?: string;
  AI: Ai;
  DB: D1Database;
};
