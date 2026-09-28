export type Bindings = {
  APP_ENV: string;
  ANALYZER_MODE: "fake" | "workers-ai";
  TTS_MODE: "fake" | "workers-ai";
  ASSEMBLYAI_API_KEY?: string;
  DEMO_API_KEY: string;
  AI: Ai;
  DB: D1Database;
};
