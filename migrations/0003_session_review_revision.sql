ALTER TABLE sessions ADD COLUMN reviewed_revision INTEGER;

CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

