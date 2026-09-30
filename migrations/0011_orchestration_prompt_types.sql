-- Add two fixed, state-authorized W07 prompts; preserve all existing requests.
CREATE TABLE speech_requests_w07 (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  utterance_type TEXT NOT NULL CHECK (utterance_type IN ('opening', 'follow_up', 'summary', 'save_confirmation', 'silence_confirmation', 'correction_prompt')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(session_id, id)
);
INSERT INTO speech_requests_w07 SELECT id, session_id, utterance_type, created_at FROM speech_requests;
DROP TABLE speech_requests;
ALTER TABLE speech_requests_w07 RENAME TO speech_requests;
CREATE INDEX idx_speech_requests_session_id ON speech_requests(session_id, created_at);
