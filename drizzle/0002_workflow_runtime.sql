ALTER TABLE travel_jobs ADD COLUMN workflow_id TEXT;
ALTER TABLE travel_jobs ADD COLUMN engine_version TEXT NOT NULL DEFAULT 'v29-sites-checkpoint';
ALTER TABLE travel_jobs ADD COLUMN current_step TEXT;
ALTER TABLE travel_jobs ADD COLUMN heartbeat_at INTEGER;
ALTER TABLE travel_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE travel_jobs ADD COLUMN lease_nonce TEXT;
ALTER TABLE travel_jobs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE travel_jobs ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE travel_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE travel_jobs ADD COLUMN error_code TEXT;
ALTER TABLE travel_jobs ADD COLUMN completed_at INTEGER;
ALTER TABLE travel_jobs ADD COLUMN session_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS travel_job_artifacts (
  job_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, artifact_key)
);

CREATE TABLE IF NOT EXISTS travel_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  step TEXT,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS travel_job_provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  step TEXT,
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  code TEXT,
  detail TEXT,
  latency_ms INTEGER,
  result_count INTEGER,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_travel_jobs_session_status ON travel_jobs(session_hash, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_travel_jobs_heartbeat ON travel_jobs(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_travel_job_events_job ON travel_job_events(job_id, id);
CREATE INDEX IF NOT EXISTS idx_travel_job_provider_attempts_job ON travel_job_provider_attempts(job_id, id);

PRAGMA optimize;
