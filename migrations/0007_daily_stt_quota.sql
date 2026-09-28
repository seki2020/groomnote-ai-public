CREATE TABLE daily_stt_usage (
  quota_date TEXT PRIMARY KEY,
  token_issuances INTEGER NOT NULL DEFAULT 0 CHECK (token_issuances >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
