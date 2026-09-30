CREATE TABLE correction_requests (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider_turn_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'AWAITING_FOLLOWUP', 'COMPLETED', 'FAILED')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  last_round_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, provider_turn_id)
);
CREATE UNIQUE INDEX one_pending_correction_per_session ON correction_requests(session_id)
  WHERE status IN ('PROCESSING', 'AWAITING_FOLLOWUP');
