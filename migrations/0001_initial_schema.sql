PRAGMA foreign_keys = ON;

CREATE TABLE pets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  breed TEXT,
  distinguishing_details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_pets_name ON pets(name COLLATE NOCASE);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE RESTRICT,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_appointments_pet_id ON appointments(pet_id);
CREATE INDEX idx_appointments_scheduled_at ON appointments(scheduled_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  current_draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_draft_revision >= 0),
  approved_revision INTEGER CHECK (approved_revision IS NULL OR approved_revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_appointment_id ON sessions(appointment_id);
CREATE INDEX idx_sessions_state ON sessions(state);

CREATE TABLE stt_rounds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'COMPLETED', 'FAILED', 'CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE(session_id, round_number)
);

CREATE INDEX idx_stt_rounds_session_id ON stt_rounds(session_id);

CREATE TABLE transcript_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stt_round_id TEXT NOT NULL REFERENCES stt_rounds(id) ON DELETE CASCADE,
  provider_turn_id TEXT NOT NULL,
  transcript TEXT NOT NULL CHECK (length(trim(transcript)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(session_id, provider_turn_id)
);

CREATE INDEX idx_transcript_turns_round_id ON transcript_turns(stt_round_id);

CREATE TABLE note_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  spoken_summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(session_id, revision)
);

CREATE INDEX idx_note_drafts_session_id ON note_drafts(session_id);

CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_session_events_session_id ON session_events(session_id, created_at);

CREATE TABLE handover_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE RESTRICT,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_handover_notes_pet_id ON handover_notes(pet_id, created_at);
CREATE INDEX idx_handover_notes_appointment_id ON handover_notes(appointment_id);

CREATE TABLE usage_quotas (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  quota_date TEXT NOT NULL,
  stt_token_issuances INTEGER NOT NULL DEFAULT 0 CHECK (stt_token_issuances >= 0),
  llm_calls INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0),
  tts_calls INTEGER NOT NULL DEFAULT 0 CHECK (tts_calls >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_usage_quotas_date ON usage_quotas(quota_date);

