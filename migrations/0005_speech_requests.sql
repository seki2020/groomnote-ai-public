CREATE TABLE speech_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  utterance_type TEXT NOT NULL CHECK (utterance_type IN ('opening', 'follow_up', 'summary', 'save_confirmation')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(session_id, id)
);

CREATE INDEX idx_speech_requests_session_id ON speech_requests(session_id, created_at);
