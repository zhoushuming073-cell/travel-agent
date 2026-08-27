CREATE TABLE IF NOT EXISTS travel_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  progress_json TEXT,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_jobs_client_idempotency
ON travel_jobs(client_hash, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_travel_jobs_client_status
ON travel_jobs(client_hash, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_travel_jobs_expires_at
ON travel_jobs(expires_at);

CREATE TABLE IF NOT EXISTS api_usage (
  client_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(client_hash, endpoint, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_updated_at
ON api_usage(updated_at);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  latency_ms INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_health_updated_at
ON provider_health(updated_at);

CREATE TABLE IF NOT EXISTS response_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_response_cache_expires_at
ON response_cache(expires_at);

PRAGMA optimize;
