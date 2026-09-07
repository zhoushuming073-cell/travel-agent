import assert from "node:assert/strict";
import test from "node:test";
import { parseAvailabilityWindows } from "../worker/domain/availability.ts";
import { compileConstraintModel } from "../worker/domain/constraint-model.ts";
import { buildPlanDiversityProfiles } from "../worker/domain/diversity.ts";
import { buildPlanningFactGraph } from "../worker/domain/fact-graph.ts";
import { fixedBenchmarkScenarios, runOfflineBenchmark } from "../worker/domain/offline-benchmark.ts";
import { stableHash } from "../worker/domain/reproducibility.ts";
import { requestCorrelation } from "../worker/domain/research-planner.ts";
import { workflowExecutionGroups } from "../worker/domain/workflow-dag.ts";

test("availability compiler keeps split windows and weekday closures", () => {
  const split = parseAvailabilityWindows({ openingHours: "09:00-12:00；13:30-17:00；最后入场16:00", dates: ["2026-09-10"], sourceId: "official", verified: true });
  assert.equal(split.length, 2);
  assert.equal(split[1].lastAdmission, "16:00");
  const closed = parseAvailabilityWindows({ openingHours: "09:00-17:00，周一闭馆", dates: ["2026-09-07"], sourceId: "official", verified: true });
  assert.equal(closed[0].status, "closed");
});

test("constraint compiler surfaces a minimal explicit conflict before planning", () => {
  const model = compileConstraintModel({ city: "测试城", startDate: "2026-09-10", days: 1, requiredAttractions: ["A"], excludedAttractions: ["A"], preferences: ["建筑"] } as Parameters<typeof compileConstraintModel>[0]);
  assert.equal(model.conflicts.length, 1);
  assert.match(model.conflicts[0].reason, /A/);
});

test("fact graph retains entity, source, fact version and provenance edges", () => {
  const plan = { daysPlan: [{ day: 1, items: [{ id: "a", name: "A", officialName: "A馆" }] }] } as Parameters<typeof buildPlanningFactGraph>[0];
  const facts = [{ id: "f1", subject: "A", field: "开放时间", value: "09:00-17:00", status: "verified", confidence: 0.9, sourceType: "provider", sourceName: "官网", sourceUrl: null, updatedAt: "2026-09-07T00:00:00Z", fetchedAt: "2026-09-07T00:00:00Z", importance: "high", uncertaintyReason: null, downstreamImpact: "排程", observations: [{ value: "09:00-17:00", confidence: 0.9, source: { id: "official", name: "官网", type: "official", url: null, quality: "verified", fetchedAt: "2026-09-07T00:00:00Z" } }] }] as Parameters<typeof buildPlanningFactGraph>[1];
  const graph = buildPlanningFactGraph(plan, facts, "2026-09-07T00:00:00Z");
  assert.ok(graph.nodes.some((node) => node.kind === "entity"));
  assert.ok(graph.nodes.some((node) => node.factVersion === "f1@2026-09-07T00:00:00Z"));
  assert.ok(graph.edges.some((edge) => edge.relation === "supported-by"));
});

test("stable hash ignores object key insertion order", () => {
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
});

test("research query correlation penalizes same-target same-fact repetition", () => {
  const similar = requestCorrelation({ targetId: "a", questionType: "opening_hours", query: "A 开放时间 官方" }, { targetId: "a", questionType: "opening_hours", query: "A 营业开放时间 官网" });
  const diverse = requestCorrelation({ targetId: "a", questionType: "opening_hours", query: "A 开放时间 官方" }, { targetId: "b", questionType: "crowd_pattern", query: "B 周末排队" });
  assert.ok(similar > diverse);
});

test("variant diversity measures experience, area, time and pace beyond POI overlap", () => {
  const plans = [
    { id: "hot", daysPlan: [{ day: 1, items: [{ id: "a", category: "建筑", district: "中环", startTime: "10:00" }] }] },
    { id: "niche", daysPlan: [{ day: 1, items: [{ id: "b", category: "博物馆", district: "九龙", startTime: "18:00" }] }] },
  ] as unknown as Parameters<typeof buildPlanDiversityProfiles>[0];
  const result = buildPlanDiversityProfiles(plans);
  assert.ok(result.niche.overall > 0.5);
  assert.ok(result.niche.category > 0);
});

test("workflow metadata is an acyclic dependency DAG", () => {
  const groups = workflowExecutionGroups();
  assert.equal(groups[0][0], "parse_profile");
  assert.ok(groups.flat().includes("contract_validation"));
});

test("offline benchmark runs 120 fixed requests without model dependency", () => {
  const report = runOfflineBenchmark(fixedBenchmarkScenarios());
  assert.equal(report.scenarioCount, 120);
  assert.equal(report.mustVisitCoverage, 1);
  assert.equal(report.deterministicSuccessRate, 1);
  assert.ok(report.averageTransitMinutes >= 0);
});
