import { AI_RATE_LIMIT_COOLDOWN_MS, classifyAiFailure } from "./model-routing.ts";

// A conservative site-wide default, not a claim about the provider's account quota.
export function aiRequestInterval(env: Record<string, unknown>): number {
  const value = Number(env.AI_REQUEST_MIN_INTERVAL_MS ?? AI_RATE_LIMIT_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 0 ? Math.max(1000, Math.min(300_000, value)) : AI_RATE_LIMIT_COOLDOWN_MS;
}

export function isAiRateLimited(error: unknown): boolean {
  return /\[RATE_LIMITED\]|\b429\b|QPM|请求过于频繁/i.test(error instanceof Error ? error.message : String(error));
}

interface ThrottleRuntime {
  acquire(): Promise<number>; // 0 grants this request; otherwise milliseconds until retry.
  block(milliseconds: number): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  assertActive?(): Promise<void>;
  random?(): number;
  /** Maximum time this HTTP request may spend sleeping for a future slot. */
  inRequestWaitBudgetMs?: number;
}

export class DurableAiWaitError extends Error {
  readonly code = "AI_DURABLE_WAIT";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`[DURABLE_WAIT] AI slot available in ${Math.max(1, Math.ceil(retryAfterMs))}ms`);
    this.name = "DurableAiWaitError";
    this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
  }
}

export function isDurableAiWait(error: unknown): error is DurableAiWaitError {
  return error instanceof DurableAiWaitError
    || (error instanceof Error && /\[DURABLE_WAIT\]|AI_DURABLE_WAIT/.test(error.message));
}

export async function requestWithAiThrottle<T>(request: () => Promise<T>, runtime: ThrottleRuntime): Promise<T> {
  // Retry the SAME HTTP request, not the whole multi-call research/repair stage.
  const inRequestWaitBudgetMs = Math.max(0, runtime.inRequestWaitBudgetMs ?? 5_000);
  let sleptMs = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (;;) {
      await runtime.assertActive?.();
      const wait = await runtime.acquire();
      if (!wait) break;
      const shortWait = Math.min(wait, 1_000);
      if (sleptMs + shortWait > inRequestWaitBudgetMs || wait > inRequestWaitBudgetMs - sleptMs) {
        throw new DurableAiWaitError(wait);
      }
      await runtime.sleep(shortWait);
      sleptMs += shortWait;
    }
    try { return await request(); }
    catch (error) {
      if (classifyAiFailure(error) !== "RATE_LIMITED") throw error;
      // Persist the cooldown so another Worker/request cannot immediately hit the same quota.
      const jitter = runtime.random ? Math.floor(runtime.random() * 15_001) : 0;
      await runtime.block(AI_RATE_LIMIT_COOLDOWN_MS + jitter);
      if (attempt === 2) throw error;
    }
  }
  throw new Error("模型重试预算耗尽");
}
