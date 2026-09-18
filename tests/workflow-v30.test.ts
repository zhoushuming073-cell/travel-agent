import assert from "node:assert/strict";
import test from "node:test";
import { DurableAiWaitError, requestWithAiThrottle } from "../worker/domain/ai-throttle.ts";
import { createAdaptiveResearchBudget } from "../worker/domain/research-budget.ts";
import type { ResearchGap, ResearchRequest } from "../worker/domain/research-types.ts";
import { executeExternalCall, ExternalCallTimeoutError } from "../worker/workflow/model-execution.ts";
import {
  AdvanceBudgetExhaustedError,
  createAdvanceExecutionBudget,
  externalCallTimeoutMs,
} from "../worker/workflow/advance-budget.ts";
import { leaseWaitSchedule, runtimeStateForClient } from "../worker/workflow/runtime-state.ts";
import {
  advancePlannerResearch,
  planResearchQueriesWithFallback,
  type ResearchArtifactStore,
  type ResearchRuntime,
} from "../worker/workflow/research/research-runner.ts";
import type { PlannerResearchState } from "../worker/workflow/research/research-state.ts";
import { HONG_KONG_V30_INCIDENT_FIXTURE } from "./fixtures/hong-kong-v30.ts";

class MemoryStore implements ResearchArtifactStore {
  values = new Map<string, unknown>();
  writes = new Map<string, number>();

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async put(key: string, value: unknown): Promise<{ created: boolean }> {
    const created = !this.values.has(key);
    this.values.set(key, structuredClone(value));
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
    return { created };
  }
}

const gap: ResearchGap = {
  id: "gap:hk:opening_hours",
  targetId: "hk",
  targetName: "香港大学",
  factType: "opening_hours",
  currentStatus: "unknown",
  decisionImpact: 0.9,
  uncertainty: 0.8,
  expectedInformationGain: 0.7,
  researchCost: 0.5,
  freshnessNeed: 0.8,
  blocking: true,
  reason: "核验开放时间",
  affectedDecisions: ["visit_time"],
};

const request: ResearchRequest = {
  queryId: "query:hk:opening_hours:1",
  targetId: "hk",
  targetName: "香港大学",
  questionType: "opening_hours",
  query: "香港大学 2027-09-10 开放时间 官方",
  reason: gap.reason,
  expectedDecisionImpact: 0.9,
  expectedInformationGain: 0.7,
  estimatedCost: 0.5,
  preferredSourceTiers: ["tier_1_official"],
  generatedBy: "deterministic",
};

function runtime(counters: Record<string, number>): ResearchRuntime {
  return {
    async initialize() {
      counters.initialize += 1;
      return {
        gaps: [gap],
        budget: createAdaptiveResearchBudget({
          tripDays: HONG_KONG_V30_INCIDENT_FIXTURE.days,
          cityCount: 1,
          requiredSpotCount: 1,
          blockingUnknownCount: 1,
          highRiskFactCount: 1,
          candidateCount: 1,
          deepResearch: false,
        }),
        maxRounds: 1,
      };
    },
    async planQueries() { counters.plan += 1; return { requests: [request], model: "fake-pro", modelStatus: "ready", aiCalls: 1 }; },
    async search(requests) {
      counters.search += 1;
      return requests.map((current) => ({ request: current, results: [], providersAttempted: ["fake-search"] }));
    },
    async fetch() { counters.fetch += 1; return []; },
    async extract() { counters.extract += 1; return []; },
    async refine(evidence) { counters.refine += 1; return { evidence, aiCalls: 0 }; },
    async fuse({ state }) {
      counters.fuse += 1;
      return { facts: [], gaps: state.gaps, budget: { ...state.budget, remainingCostUnits: state.budget.remainingCostUnits - 1 }, informationGain: 0, continueResearch: false, stopReason: "round_limit" };
    },
    async finalize({ state }) { counters.finalize += 1; return { fixture: HONG_KONG_V30_INCIDENT_FIXTURE.prompt, stateVersion: state.version }; },
  };
}

function counters() {
  return { initialize: 0, plan: 0, search: 0, fetch: 0, extract: 0, refine: 0, fuse: 0, finalize: 0 };
}

test("V30 research resumes after query planning instead of planning again", async () => {
  const store = new MemoryStore();
  const calls = counters();
  await advancePlannerResearch(store, runtime(calls)); // init
  const planned = await advancePlannerResearch(store, runtime(calls)); // query plan
  assert.equal(planned.state.cursor.step, "search_batch");
  assert.equal(calls.plan, 1);

  // A fresh runtime represents a new Worker after the previous process ended.
  await advancePlannerResearch(store, runtime(calls));
  assert.equal(calls.plan, 1);
  assert.equal(calls.search, 1);
});

test("V30 search operation is idempotent when artifact exists but cursor was not committed", async () => {
  const store = new MemoryStore();
  const calls = counters();
  await advancePlannerResearch(store, runtime(calls));
  await advancePlannerResearch(store, runtime(calls));
  const operationKey = "research:v30:operation:r0:search_batch:0";
  await store.put(operationKey, [{ request, results: [], providersAttempted: ["fake-search"] }]);
  const writesBefore = store.writes.get(operationKey);

  const resumed = await advancePlannerResearch(store, runtime(calls));
  assert.equal(resumed.reused, true);
  assert.equal(calls.search, 0);
  assert.equal(store.writes.get(operationKey), writesBefore);
  assert.deepEqual(resumed.state.completedQueryIds, [request.queryId]);
});

test("V30 active timeout aborts before platform kill and cleanup still runs", async () => {
  let released = false;
  let telemetry = "";
  const started = Date.now();
  await assert.rejects(async () => {
    try {
      await executeExternalCall("fake planner", (signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), { timeoutMs: 20, onSettled: (value) => { telemetry = value.outcome; } });
    } finally {
      released = true;
    }
  }, ExternalCallTimeoutError);
  assert.equal(released, true);
  assert.equal(telemetry, "timeout");
  assert.ok(Date.now() - started < 500);
});

test("V30 throttle turns a 65 second slot wait into a quick durable retry", async () => {
  const started = Date.now();
  await assert.rejects(requestWithAiThrottle(async () => "unreachable", {
    acquire: async () => HONG_KONG_V30_INCIDENT_FIXTURE.simulatedLatency.throttleMs,
    block: async () => undefined,
    sleep: async () => { throw new Error("must not sleep"); },
    now: Date.now,
    inRequestWaitBudgetMs: 2_000,
  }), (error: unknown) => error instanceof DurableAiWaitError && error.retryAfterMs === 65_000);
  assert.ok(Date.now() - started < 200);
});

test("V30 research query planner timeout uses deterministic requests", async () => {
  const planned = await planResearchQueriesWithFallback({
    ai: async () => { throw new ExternalCallTimeoutError(30_000, "research planner"); },
    deterministic: () => [request],
  });
  assert.deepEqual(planned.value, [request]);
  assert.match(planned.degradedReason ?? "", /timeout/);
});

test("V30 crash recovery reuses completed operation IDs without spending budget twice", async () => {
  const store = new MemoryStore();
  const calls = counters();
  let result = await advancePlannerResearch(store, runtime(calls));
  while (!result.done) result = await advancePlannerResearch(store, runtime(calls));
  const finalState = await store.get<PlannerResearchState>("research:state:v30");
  assert.equal(calls.fuse, 1);
  assert.equal(finalState?.informationGains.length, 1);
  assert.equal(finalState?.remainingBudget, finalState?.budget.remainingCostUnits);
  const repeated = await advancePlannerResearch(store, runtime(calls));
  assert.equal(repeated.done, true);
  assert.equal(calls.fuse, 1);
});

test("V30 planner, critic and repair calls all obey the active timeout boundary", async () => {
  for (const purpose of ["planner", "critic", "repair"] as const) {
    const started = Date.now();
    await assert.rejects(executeExternalCall(purpose, (signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), { timeoutMs: 15 }), ExternalCallTimeoutError);
    assert.ok(Date.now() - started < 500, `${purpose} exceeded test timeout boundary`);
  }
});

test("V30 does not start a fallback model without a useful execution window", () => {
  const budget = createAdvanceExecutionBudget(1_000, 40_000);
  assert.equal(externalCallTimeoutMs(budget, 30_000, 1_000), 30_000);
  assert.throws(
    () => externalCallTimeoutMs(budget, 30_000, 34_500),
    AdvanceBudgetExhaustedError,
  );
  assert.equal(externalCallTimeoutMs(budget, 3_000, 32_000), 3_000);
});

test("V30 lease contention is exposed as a durable waiting window", () => {
  const now = 100_000;
  const wait = leaseWaitSchedule(now + 31_000, now);
  assert.deepEqual(wait, { retryAfterMs: 31_500, retryNotBefore: 131_500 });
  const runtime = runtimeStateForClient({
    version: 30,
    mode: "waiting",
    currentStage: "planner_research",
    currentMicroStep: "planner_research:round:0:plan_queries",
    microStepStartedAt: now - 30_000,
    lastHeartbeatAt: now,
    retryNotBefore: wait.retryNotBefore,
    attempt: 1,
  }, now, now + 31_000);
  assert.equal(runtime?.mode, "waiting");
});
