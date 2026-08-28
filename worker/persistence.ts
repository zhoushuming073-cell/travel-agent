interface D1Result<T = unknown> {
  success?: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface DurableTravelJob {
  id: string;
  idempotencyKey: string;
  clientHash: string;
  accessTokenHash: string;
  status: "queued" | "working" | "needs_input" | "done" | "error" | "cancelled";
  payload: unknown;
  progress: unknown | null;
  result: unknown | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  workflowId: string | null;
  engineVersion: string;
  currentStep: string | null;
  heartbeatAt: number | null;
  leaseOwner: string | null;
  leaseNonce: string | null;
  leaseExpiresAt: number | null;
  cancelRequestedAt: number | null;
  attemptCount: number;
  errorCode: string | null;
  completedAt: number | null;
  sessionHash: string;
}

export interface TravelJobEvent {
  id?: number;
  jobId: string;
  eventType: string;
  step: string | null;
  message: string;
  detail?: unknown;
  createdAt: number;
}

export interface ProviderAttempt {
  provider: string;
  capability: string;
  status: "success" | "degraded" | "rate_limited" | "failed" | "skipped";
  code?: string | null;
  detail?: string | null;
  latencyMs?: number | null;
  resultCount?: number | null;
  fetchedAt?: string;
}

let runtimeDb: D1DatabaseLike | null = null;
let schemaReady: Promise<void> | null = null;

export function configurePersistence(db: D1DatabaseLike | null | undefined): void {
  if (db && runtimeDb !== db) {
    runtimeDb = db;
    schemaReady = null;
  }
}

export function persistenceAvailable(): boolean {
  return Boolean(runtimeDb);
}

async function ensureSchema(): Promise<D1DatabaseLike | null> {
  if (!runtimeDb) return null;
  if (!schemaReady) {
    const db = runtimeDb;
    schemaReady = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS travel_jobs (
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
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS api_usage (
          client_hash TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          bucket_start INTEGER NOT NULL,
          window_ms INTEGER NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(client_hash, endpoint, bucket_start)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS provider_health (
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
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS response_cache (
          cache_key TEXT PRIMARY KEY NOT NULL,
          namespace TEXT NOT NULL,
          value_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS travel_job_artifacts (
          job_id TEXT NOT NULL,
          artifact_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          checksum TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(job_id, artifact_key)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS travel_job_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          step TEXT,
          message TEXT NOT NULL,
          detail_json TEXT,
          created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS travel_job_provider_attempts (
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
        )`),
      ]);
      const columns = await db.prepare("PRAGMA table_info(travel_jobs)").all<{ name: string }>();
      const existingColumns = new Set((columns.results || []).map((column) => String(column.name)));
      const additions: Array<[string, string]> = [
        ["workflow_id", "TEXT"], ["engine_version", "TEXT NOT NULL DEFAULT 'v29-sites-checkpoint'"],
        ["current_step", "TEXT"], ["heartbeat_at", "INTEGER"], ["lease_owner", "TEXT"],
        ["lease_nonce", "TEXT"], ["lease_expires_at", "INTEGER"], ["cancel_requested_at", "INTEGER"],
        ["attempt_count", "INTEGER NOT NULL DEFAULT 0"], ["error_code", "TEXT"],
        ["completed_at", "INTEGER"], ["session_hash", "TEXT NOT NULL DEFAULT ''"],
      ];
      for (const [name, definition] of additions) {
        if (!existingColumns.has(name)) await db.prepare(`ALTER TABLE travel_jobs ADD COLUMN ${name} ${definition}`).run();
      }
      await db.batch([
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_jobs_client_idempotency ON travel_jobs(client_hash, idempotency_key)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_jobs_client_status ON travel_jobs(client_hash, status, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_jobs_expires_at ON travel_jobs(expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_api_usage_updated_at ON api_usage(updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_health_updated_at ON provider_health(updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_response_cache_expires_at ON response_cache(expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_jobs_session_status ON travel_jobs(session_hash, status, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_jobs_heartbeat ON travel_jobs(status, heartbeat_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_job_events_job ON travel_job_events(job_id, id)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_job_provider_attempts_job ON travel_job_provider_attempts(job_id, id)"),
      ]);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
  return runtimeDb;
}

function parseJson(value: unknown): unknown | null {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestClientHash(request: Request, salt = "smart-travel-public"): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const userAgent = request.headers.get("user-agent") || "unknown";
  return sha256(`${salt}|${ip}|${userAgent.slice(0, 160)}`);
}

export async function consumeRateLimit(clientHash: string, endpoint: string, limit: number, windowMs: number) {
  const db = await ensureSchema();
  if (!db) return { allowed: true, count: 0, limit, retryAfterSeconds: 0 };
  const now = Date.now();
  const bucketStart = Math.floor(now / windowMs) * windowMs;
  await db.prepare(`INSERT INTO api_usage(client_hash, endpoint, bucket_start, window_ms, request_count, updated_at)
    VALUES(?, ?, ?, ?, 1, ?)
    ON CONFLICT(client_hash, endpoint, bucket_start)
    DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at`)
    .bind(clientHash, endpoint, bucketStart, windowMs, now).run();
  const row = await db.prepare("SELECT request_count FROM api_usage WHERE client_hash = ? AND endpoint = ? AND bucket_start = ?")
    .bind(clientHash, endpoint, bucketStart).first<{ request_count: number }>();
  const count = Number(row?.request_count || 0);
  return { allowed: count <= limit, count, limit, retryAfterSeconds: Math.max(1, Math.ceil((bucketStart + windowMs - now) / 1000)) };
}

export async function activeJobCount(clientHash?: string): Promise<number> {
  const db = await ensureSchema();
  if (!db) return 0;
  const now = Date.now();
  const row = clientHash
    ? await db.prepare("SELECT COUNT(*) AS count FROM travel_jobs WHERE client_hash = ? AND status IN ('queued','working','needs_input') AND expires_at > ?").bind(clientHash, now).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM travel_jobs WHERE status IN ('queued','working','needs_input') AND expires_at > ?").bind(now).first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function createTravelJob(job: DurableTravelJob): Promise<{ job: DurableTravelJob; created: boolean }> {
  const db = await ensureSchema();
  if (!db) throw new Error("规划任务数据库未配置");
  const existing = await db.prepare("SELECT * FROM travel_jobs WHERE client_hash = ? AND idempotency_key = ?")
    .bind(job.clientHash, job.idempotencyKey).first<Record<string, unknown>>();
  if (existing) return { job: rowToJob(existing), created: false };
  await db.prepare(`INSERT INTO travel_jobs(
    id, idempotency_key, client_hash, access_token_hash, status, payload_json, progress_json,
    result_json, error_message, created_at, updated_at, expires_at, workflow_id, engine_version,
    current_step, heartbeat_at, lease_owner, lease_nonce, lease_expires_at, cancel_requested_at,
    attempt_count, error_code, completed_at, session_hash
  ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?)`)
    .bind(job.id, job.idempotencyKey, job.clientHash, job.accessTokenHash, job.status, JSON.stringify(job.payload), JSON.stringify(job.progress), job.createdAt, job.updatedAt, job.expiresAt, job.workflowId, job.engineVersion, job.currentStep, job.heartbeatAt, job.sessionHash).run();
  return { job, created: true };
}

function rowToJob(row: Record<string, unknown>): DurableTravelJob {
  return {
    id: String(row.id), idempotencyKey: String(row.idempotency_key), clientHash: String(row.client_hash),
    accessTokenHash: String(row.access_token_hash), status: String(row.status) as DurableTravelJob["status"],
    payload: parseJson(row.payload_json), progress: parseJson(row.progress_json), result: parseJson(row.result_json),
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
    workflowId: row.workflow_id ? String(row.workflow_id) : null,
    engineVersion: String(row.engine_version || "v29-sites-checkpoint"), currentStep: row.current_step ? String(row.current_step) : null,
    heartbeatAt: row.heartbeat_at == null ? null : Number(row.heartbeat_at), leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseNonce: row.lease_nonce ? String(row.lease_nonce) : null, leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    cancelRequestedAt: row.cancel_requested_at == null ? null : Number(row.cancel_requested_at), attemptCount: Number(row.attempt_count || 0),
    errorCode: row.error_code ? String(row.error_code) : null, completedAt: row.completed_at == null ? null : Number(row.completed_at),
    sessionHash: String(row.session_hash || ""),
  };
}

export async function getTravelJob(id: string): Promise<DurableTravelJob | null> {
  const db = await ensureSchema();
  if (!db) return null;
  const row = await db.prepare("SELECT * FROM travel_jobs WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? rowToJob(row) : null;
}

export async function updateTravelJob(id: string, update: { status?: DurableTravelJob["status"]; progress?: unknown; result?: unknown; errorMessage?: string | null; errorCode?: string | null; currentStep?: string | null; workflowId?: string | null; heartbeatAt?: number | null; completedAt?: number | null }): Promise<void> {
  const db = await ensureSchema();
  if (!db) return;
  await db.prepare(`UPDATE travel_jobs SET status = COALESCE(?, status), progress_json = COALESCE(?, progress_json),
    result_json = COALESCE(?, result_json), error_message = ?, error_code = ?, current_step = COALESCE(?, current_step),
    workflow_id = COALESCE(?, workflow_id), heartbeat_at = COALESCE(?, heartbeat_at), completed_at = COALESCE(?, completed_at), updated_at = ? WHERE id = ?`)
    .bind(update.status ?? null, update.progress === undefined ? null : JSON.stringify(update.progress), update.result === undefined ? null : JSON.stringify(update.result), update.errorMessage ?? null, update.errorCode ?? null, update.currentStep ?? null, update.workflowId ?? null, update.heartbeatAt ?? null, update.completedAt ?? null, Date.now(), id).run();
}

export async function findActiveTravelJob(sessionHash: string): Promise<DurableTravelJob | null> {
  const db = await ensureSchema();
  if (!db || !sessionHash) return null;
  const row = await db.prepare(`SELECT * FROM travel_jobs WHERE session_hash = ? AND status IN ('queued','working','needs_input') AND expires_at > ? ORDER BY updated_at DESC LIMIT 1`)
    .bind(sessionHash, Date.now()).first<Record<string, unknown>>();
  return row ? rowToJob(row) : null;
}

export async function putTravelJobArtifact(jobId: string, key: string, value: unknown): Promise<{ created: boolean; checksum: string }> {
  const db = await ensureSchema();
  if (!db) throw new Error("规划任务数据库未配置");
  const serialized = JSON.stringify(value);
  const checksum = await sha256(serialized);
  const existing = await db.prepare("SELECT checksum FROM travel_job_artifacts WHERE job_id = ? AND artifact_key = ?").bind(jobId, key).first<{ checksum: string }>();
  if (existing?.checksum === checksum) return { created: false, checksum };
  const now = Date.now();
  await db.prepare(`INSERT INTO travel_job_artifacts(job_id, artifact_key, value_json, checksum, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, artifact_key) DO UPDATE SET value_json = excluded.value_json,
    checksum = excluded.checksum, updated_at = excluded.updated_at`).bind(jobId, key, serialized, checksum, now, now).run();
  return { created: !existing, checksum };
}

export async function getTravelJobArtifact<T = unknown>(jobId: string, key: string): Promise<T | null> {
  const db = await ensureSchema();
  if (!db) return null;
  const row = await db.prepare("SELECT value_json FROM travel_job_artifacts WHERE job_id = ? AND artifact_key = ?").bind(jobId, key).first<{ value_json: string }>();
  return (row ? parseJson(row.value_json) : null) as T | null;
}

export async function addTravelJobEvent(event: TravelJobEvent): Promise<void> {
  const db = await ensureSchema();
  if (!db) return;
  await db.prepare(`INSERT INTO travel_job_events(job_id, event_type, step, message, detail_json, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
    .bind(event.jobId, event.eventType, event.step, event.message, event.detail === undefined ? null : JSON.stringify(event.detail), event.createdAt).run();
}

export async function listTravelJobEvents(jobId: string, limit = 80): Promise<TravelJobEvent[]> {
  const db = await ensureSchema();
  if (!db) return [];
  const result = await db.prepare("SELECT * FROM travel_job_events WHERE job_id = ? ORDER BY id ASC LIMIT ?").bind(jobId, limit).all<Record<string, unknown>>();
  return (result.results || []).map((row) => ({ id: Number(row.id), jobId: String(row.job_id), eventType: String(row.event_type), step: row.step ? String(row.step) : null, message: String(row.message), detail: parseJson(row.detail_json), createdAt: Number(row.created_at) }));
}

export async function recordJobProviderAttempt(jobId: string, step: string | null, attempt: ProviderAttempt): Promise<void> {
  const db = await ensureSchema();
  if (!db) return;
  await db.prepare(`INSERT INTO travel_job_provider_attempts(job_id, step, provider, capability, status, code, detail, latency_ms, result_count, fetched_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(jobId, step, attempt.provider, attempt.capability, attempt.status, attempt.code ?? null, attempt.detail ?? null, attempt.latencyMs ?? null, attempt.resultCount ?? null, attempt.fetchedAt ? Date.parse(attempt.fetchedAt) : Date.now()).run();
}

export async function listJobProviderAttempts(jobId: string): Promise<ProviderAttempt[]> {
  const db = await ensureSchema();
  if (!db) return [];
  const result = await db.prepare("SELECT * FROM travel_job_provider_attempts WHERE job_id = ? ORDER BY id ASC").bind(jobId).all<Record<string, unknown>>();
  return (result.results || []).map((row) => ({ provider: String(row.provider), capability: String(row.capability), status: String(row.status) as ProviderAttempt["status"], code: row.code ? String(row.code) : null, detail: row.detail ? String(row.detail) : null, latencyMs: row.latency_ms == null ? null : Number(row.latency_ms), resultCount: row.result_count == null ? null : Number(row.result_count), fetchedAt: new Date(Number(row.fetched_at)).toISOString() }));
}

export async function acquireTravelJobLease(jobId: string, owner: string, nonce: string, ttlMs = 45_000): Promise<boolean> {
  const db = await ensureSchema();
  if (!db) return false;
  const now = Date.now();
  const result = await db.prepare(`UPDATE travel_jobs SET lease_owner = ?, lease_nonce = ?, lease_expires_at = ?, heartbeat_at = ?, attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ? AND status IN ('queued','working') AND cancel_requested_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)`)
    .bind(owner, nonce, now + ttlMs, now, now, jobId, now, owner).run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function renewTravelJobLease(jobId: string, owner: string, nonce: string, ttlMs = 45_000): Promise<boolean> {
  const db = await ensureSchema();
  if (!db) return false;
  const now = Date.now();
  const result = await db.prepare(`UPDATE travel_jobs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND lease_nonce = ? AND cancel_requested_at IS NULL AND status = 'working'`)
    .bind(now + ttlMs, now, now, jobId, owner, nonce).run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function releaseTravelJobLease(jobId: string, owner: string, nonce: string): Promise<void> {
  const db = await ensureSchema();
  if (!db) return;
  await db.prepare("UPDATE travel_jobs SET lease_owner = NULL, lease_nonce = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND lease_nonce = ?").bind(Date.now(), jobId, owner, nonce).run();
}

export async function requestTravelJobCancellation(jobId: string, sessionHash: string): Promise<boolean> {
  const db = await ensureSchema();
  if (!db) return false;
  const now = Date.now();
  const result = await db.prepare(`UPDATE travel_jobs SET status = 'cancelled', cancel_requested_at = ?, completed_at = ?, error_code = 'USER_CANCELLED', updated_at = ? WHERE id = ? AND session_hash = ? AND status IN ('queued','working','needs_input')`)
    .bind(now, now, now, jobId, sessionHash).run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function persistentCacheGet(namespace: string, key: string): Promise<unknown | null> {
  try {
    const db = await ensureSchema();
    if (!db) return null;
    const now = Date.now();
    const cacheKey = await sha256(`${namespace}|${key}`);
    const row = await db.prepare("SELECT value_json FROM response_cache WHERE cache_key = ? AND expires_at > ?")
      .bind(cacheKey, now).first<{ value_json: string }>();
    if (!row) return null;
    await db.prepare("UPDATE response_cache SET hit_count = hit_count + 1 WHERE cache_key = ?").bind(cacheKey).run();
    return parseJson(row.value_json);
  } catch { return null; }
}

export async function persistentCachePut(namespace: string, key: string, value: unknown, ttlMs: number): Promise<void> {
  try {
    const db = await ensureSchema();
    if (!db) return;
    const now = Date.now();
    const cacheKey = await sha256(`${namespace}|${key}`);
    await db.prepare(`INSERT INTO response_cache(cache_key, namespace, value_json, created_at, expires_at, hit_count)
      VALUES(?, ?, ?, ?, ?, 0)
      ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at,
        expires_at = excluded.expires_at, hit_count = 0`)
      .bind(cacheKey, namespace, JSON.stringify(value), now, now + ttlMs).run();
  } catch { /* provider calls must not fail because telemetry cache is unavailable */ }
}

export async function recordProviderHealth(provider: string, outcome: { ok: boolean; latencyMs?: number; error?: string; rateLimited?: boolean; cacheHit?: boolean }): Promise<void> {
  try {
    const db = await ensureSchema();
    if (!db || !provider) return;
    const now = Date.now();
    const errorCode = outcome.rateLimited ? "429" : outcome.error?.match(/\b(4\d\d|5\d\d)\b/)?.[1] || null;
    const status = outcome.ok ? "healthy" : outcome.rateLimited ? "degraded" : "unavailable";
    await db.prepare(`INSERT INTO provider_health(
    provider, status, last_success_at, last_failure_at, latency_ms, last_error_code,
    last_error_message, total_requests, success_count, failure_count, rate_limited_count, cache_hits, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  ON CONFLICT(provider) DO UPDATE SET
    status = excluded.status,
    last_success_at = CASE WHEN excluded.status = 'healthy' THEN excluded.updated_at ELSE provider_health.last_success_at END,
    last_failure_at = CASE WHEN excluded.status != 'healthy' THEN excluded.updated_at ELSE provider_health.last_failure_at END,
    latency_ms = excluded.latency_ms,
    last_error_code = excluded.last_error_code,
    last_error_message = excluded.last_error_message,
    total_requests = provider_health.total_requests + 1,
    success_count = provider_health.success_count + excluded.success_count,
    failure_count = provider_health.failure_count + excluded.failure_count,
    rate_limited_count = provider_health.rate_limited_count + excluded.rate_limited_count,
    cache_hits = provider_health.cache_hits + excluded.cache_hits,
    updated_at = excluded.updated_at`)
      .bind(provider, status, outcome.ok ? now : null, outcome.ok ? null : now, outcome.latencyMs ?? null, errorCode, outcome.error?.slice(0, 240) ?? null, outcome.ok ? 1 : 0, outcome.ok ? 0 : 1, outcome.rateLimited ? 1 : 0, outcome.cacheHit ? 1 : 0, now).run();
  } catch { /* telemetry is best-effort */ }
}

export async function providerHealthSnapshot() {
  try {
    const db = await ensureSchema();
    if (!db) return [];
    const result = await db.prepare("SELECT * FROM provider_health ORDER BY updated_at DESC").all<Record<string, unknown>>();
    return (result.results || []).map((row) => ({
    provider: row.provider, status: row.status, lastSuccessAt: row.last_success_at ? new Date(Number(row.last_success_at)).toISOString() : null,
    lastFailureAt: row.last_failure_at ? new Date(Number(row.last_failure_at)).toISOString() : null,
    latencyMs: row.latency_ms, lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message,
    totalRequests: row.total_requests, successCount: row.success_count, failureCount: row.failure_count,
    rateLimitedCount: row.rate_limited_count, cacheHits: row.cache_hits,
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    }));
  } catch { return []; }
}

export async function runtimeMetrics() {
  try {
    const db = await ensureSchema();
    if (!db) return { persistence: "unavailable", providers: [], activeJobs: 0, cacheEntries: 0, cacheHits: 0, requests24h: 0 };
    const now = Date.now();
    const [jobs, cache, usage] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM travel_jobs WHERE status IN ('queued','working','needs_input') AND expires_at > ?").bind(now).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(hit_count), 0) AS hits FROM response_cache WHERE expires_at > ?").bind(now).first<{ count: number; hits: number }>(),
    db.prepare("SELECT COALESCE(SUM(request_count), 0) AS count FROM api_usage WHERE updated_at > ?").bind(now - 86_400_000).first<{ count: number }>(),
  ]);
    return { persistence: "d1", activeJobs: Number(jobs?.count || 0), cacheEntries: Number(cache?.count || 0), cacheHits: Number(cache?.hits || 0), requests24h: Number(usage?.count || 0), providers: await providerHealthSnapshot() };
  } catch { return { persistence: "unavailable", providers: [], activeJobs: 0, cacheEntries: 0, cacheHits: 0, requests24h: 0 }; }
}
