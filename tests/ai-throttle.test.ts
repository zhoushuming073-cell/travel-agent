import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { aiRequestInterval, isAiRateLimited, requestWithAiThrottle } from "../worker/domain/ai-throttle.ts";
import { acquireAiRequestSlot, blockAiRequests, configurePersistence, type D1DatabaseLike } from "../worker/persistence.ts";

function clock() {
  let now = 1000;
  let next = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    acquire: async () => { if (next > now) return next - now; next = now + 65000; return 0; },
    block: async (ms: number) => { next = Math.max(next, now + ms); },
  };
}

test("all AI purposes pace successful calls and retry the same HTTP request after QPM", async () => {
  const runtime = clock();
  const times: number[] = [];
  const request = async () => { times.push(runtime.now()); if (times.length === 1) throw new Error("429 QPM限流"); return "ok"; };
  assert.equal(await requestWithAiThrottle(request, runtime), "ok");
  assert.equal(await requestWithAiThrottle(request, runtime), "ok");
  assert.deepEqual(times, [1000, 66000, 131000]);
});

test("persistent throttling is bounded, retains rate classification and never retries unauthorized", async () => {
  let calls = 0;
  await assert.rejects(requestWithAiThrottle(async () => { calls += 1; throw new Error("429 QPM限流"); }, clock()), /429/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(requestWithAiThrottle(async () => { calls += 1; throw new Error("401 Unauthorized"); }, clock()), /401/);
  assert.equal(calls, 1);
  assert.equal(isAiRateLimited("pro [MODEL_NOT_FOUND] flash [RATE_LIMITED]"), true);
  assert.equal(aiRequestInterval({}), 65000);
  assert.equal(aiRequestInterval({ AI_REQUEST_MIN_INTERVAL_MS: "invalid" }), 65000);
  assert.equal(aiRequestInterval({ AI_REQUEST_MIN_INTERVAL_MS: "5000" }), 5000);
});

test("queue waits check cancellation before consuming another model call", async () => {
  const runtime = clock();
  await runtime.acquire();
  let checks = 0;
  let calls = 0;
  await assert.rejects(requestWithAiThrottle(async () => { calls += 1; }, {
    ...runtime, assertActive: async () => { if (++checks >= 2) throw new Error("TASK_CANCELLED"); },
  }), /TASK_CANCELLED/);
  assert.equal(calls, 0);
});

test("SQLite quota claim is atomic across parallel roles and cooldown survives another DB binding", async () => {
  const sqlite = new DatabaseSync(":memory:");
  function adapter(): D1DatabaseLike {
    return {
      prepare(sql) {
        let values: SQLInputValue[] = [];
        return {
          bind(...args) { values = args as SQLInputValue[]; return this; },
          async first<T>() { return (sqlite.prepare(sql).get(...values) || null) as T | null; },
          async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] }; },
          async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: result.changes } }; },
        };
      },
      async batch<T>(statements: Parameters<D1DatabaseLike["batch"]>[0]) { return Promise.all(statements.map((statement) => statement.run<T>())); },
    };
  }
  configurePersistence(adapter());
  const results = await Promise.all(Array.from({ length: 8 }, () => acquireAiRequestSlot("test-account", 65000, 1000)));
  assert.equal(results.filter((wait) => wait === 0).length, 1);
  assert.ok(results.filter(Boolean).every((wait) => wait === 65000));
  await blockAiRequests("test-account", 65000, 5000);
  configurePersistence(adapter());
  assert.equal(await acquireAiRequestSlot("test-account", 65000, 66000), 4000);
  assert.equal(await acquireAiRequestSlot("test-account", 65000, 70000), 0);
  assert.equal(await acquireAiRequestSlot("different-account", 65000, 70000), 0);
  const rows = sqlite.prepare("SELECT cache_key, value_json FROM response_cache").all();
  assert.ok(rows.every((row) => !String(row.cache_key).includes("account") && row.value_json === "{}"));
  sqlite.close();
});
