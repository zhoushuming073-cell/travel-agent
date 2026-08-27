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
  status: "queued" | "analysis" | "live" | "route" | "done" | "error";
  payload: unknown;
  progress: unknown | null;
  result: unknown | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
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
      ]);
      await db.batch([
        db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_jobs_client_idempotency ON travel_jobs(client_hash, idempotency_key)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_jobs_client_status ON travel_jobs(client_hash, status, updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_travel_jobs_expires_at ON travel_jobs(expires_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_api_usage_updated_at ON api_usage(updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_health_updated_at ON provider_health(updated_at)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_response_cache_expires_at ON response_cache(expires_at)"),
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
    ? await db.prepare("SELECT COUNT(*) AS count FROM travel_jobs WHERE client_hash = ? AND status IN ('queued','analysis','live','route') AND expires_at > ?").bind(clientHash, now).first<{ count: number }>()
    : await db.prepare("SELECT COUNT(*) AS count FROM travel_jobs WHERE status IN ('queued','analysis','live','route') AND expires_at > ?").bind(now).first<{ count: number }>();
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
    result_json, error_message, created_at, updated_at, expires_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
    .bind(job.id, job.idempotencyKey, job.clientHash, job.accessTokenHash, job.status, JSON.stringify(job.payload), JSON.stringify(job.progress), job.createdAt, job.updatedAt, job.expiresAt).run();
  return { job, created: true };
}

function rowToJob(row: Record<string, unknown>): DurableTravelJob {
  return {
    id: String(row.id), idempotencyKey: String(row.idempotency_key), clientHash: String(row.client_hash),
    accessTokenHash: String(row.access_token_hash), status: String(row.status) as DurableTravelJob["status"],
    payload: parseJson(row.payload_json), progress: parseJson(row.progress_json), result: parseJson(row.result_json),
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
  };
}

export async function getTravelJob(id: string): Promise<DurableTravelJob | null> {
  const db = await ensureSchema();
  if (!db) return null;
  const row = await db.prepare("SELECT * FROM travel_jobs WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return row ? rowToJob(row) : null;
}

export async function updateTravelJob(id: string, update: { status: DurableTravelJob["status"]; progress?: unknown; result?: unknown; errorMessage?: string | null }): Promise<void> {
  const db = await ensureSchema();
  if (!db) return;
  await db.prepare(`UPDATE travel_jobs SET status = ?, progress_json = COALESCE(?, progress_json),
    result_json = COALESCE(?, result_json), error_message = ?, updated_at = ? WHERE id = ?`)
    .bind(update.status, update.progress === undefined ? null : JSON.stringify(update.progress), update.result === undefined ? null : JSON.stringify(update.result), update.errorMessage ?? null, Date.now(), id).run();
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
    db.prepare("SELECT COUNT(*) AS count FROM travel_jobs WHERE status IN ('queued','analysis','live','route') AND expires_at > ?").bind(now).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(hit_count), 0) AS hits FROM response_cache WHERE expires_at > ?").bind(now).first<{ count: number; hits: number }>(),
    db.prepare("SELECT COALESCE(SUM(request_count), 0) AS count FROM api_usage WHERE updated_at > ?").bind(now - 86_400_000).first<{ count: number }>(),
  ]);
    return { persistence: "d1", activeJobs: Number(jobs?.count || 0), cacheEntries: Number(cache?.count || 0), cacheHits: Number(cache?.hits || 0), requests24h: Number(usage?.count || 0), providers: await providerHealthSnapshot() };
  } catch { return { persistence: "unavailable", providers: [], activeJobs: 0, cacheEntries: 0, cacheHits: 0, requests24h: 0 }; }
}
