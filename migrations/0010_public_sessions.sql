CREATE TABLE IF NOT EXISTS daily_public_session_usage (
  quota_date TEXT PRIMARY KEY,
  session_creations INTEGER NOT NULL DEFAULT 0 CHECK (session_creations >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
