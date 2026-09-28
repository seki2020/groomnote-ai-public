CREATE UNIQUE INDEX idx_one_open_stt_round_per_session
ON stt_rounds(session_id)
WHERE status = 'OPEN';
