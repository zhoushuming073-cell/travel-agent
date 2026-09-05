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
}

export async function requestWithAiThrottle<T>(request: () => Promise<T>, runtime: ThrottleRuntime): Promise<T> {
  // Retry the SAME HTTP request, not the whole multi-call research/repair stage.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deadline = runtime.now() + 180_000;
    for (;;) {
      await runtime.assertActive?.();
      const wait = await runtime.acquire();
      if (!wait) break;
      if (runtime.now() + wait > deadline) throw new Error("[RATE_LIMITED] 模型调用队列繁忙，请从检查点稍后重试");
      await runtime.sleep(Math.min(wait, 5000));
    }
    try { return await request(); }
    catch (error) {
      if (classifyAiFailure(error) !== "RATE_LIMITED") throw error;
      // Persist the cooldown so another Worker/request cannot immediately hit the same quota.
      await runtime.block(AI_RATE_LIMIT_COOLDOWN_MS);
      if (attempt === 2) throw error;
    }
  }
  throw new Error("模型重试预算耗尽");
}
