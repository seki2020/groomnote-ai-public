CREATE TABLE daily_provider_usage (
  quota_date TEXT PRIMARY KEY,
  llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  tts_calls INTEGER NOT NULL DEFAULT 0 CHECK (tts_calls >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
