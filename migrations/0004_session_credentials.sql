ALTER TABLE sessions ADD COLUMN session_token_hash TEXT;
CREATE UNIQUE INDEX idx_sessions_token_hash ON sessions(session_token_hash) WHERE session_token_hash IS NOT NULL;
