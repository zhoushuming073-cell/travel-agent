import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBuffers, buildDependencyGraph, calculateCriticalPath } from "../worker/domain/dependency.ts";
import { buildTravelFacts, FACT_TTL_MS, isStale, resolveObservationStatus } from "../worker/domain/facts.ts";
import { auditPlannerDraft } from "../worker/domain/planner-v4.ts";
import { proposeReplan } from "../worker/domain/replan.ts";
import { analyzeFragility } from "../worker/domain/risk.ts";
import { runStressTest } from "../worker/domain/stress.ts";
import { analyzePlanTrustV2 } from "../worker/domain/trust.ts";
import { analyzeUnknowns, buildMinimumVerification } from "../worker/domain/unknown.ts";
import { appendItineraryVersion, isLinearVersionHistory, restoreItineraryVersion } from "../worker/domain/versioning.ts";
import type { FactObservation, ItineraryPlan, TravelFact, TravelProfile } from "../worker/domain/types.ts";

const now = new Date("2026-08-21T08:00:00.000Z");
const profile: TravelProfile = {
  city: "杭州",
  startDate: "2026-10-03",
  days: 2,
  dayStart: "09:00",
  dayEnd: "21:00",
  preferences: ["自然", "摄影"],
  requiredAttractions: ["西湖", "灵隐寺"],
};

function plan(): ItineraryPlan {
  return {
    id: "relax",
    variant: "relax",
    title: "轻松舒适型",
    city: "杭州",
    startDate: profile.startDate,
    days: 2,
    generatedAt: now.toISOString(),
    weather: { source: "MCPMarket 天气", fetchedAt: now.toISOString() },
    candidatePool: [
      { id: "west-lake", name: "西湖", selected: true, requiredByUser: true },
      { id: "lingyin", name: "灵隐寺", selected: true, requiredByUser: true },
      { id: "botanical", name: "杭州植物园", selected: false },
    ],
    evaluation: { overall: 82, constraintSatisfaction: 100, evidence: { longestLegMinutes: 28 } },
    changeScope: null,
    daysPlan: [
      {
        day: 1,
        date: "2026-10-03",
        weather: { date: "2026-10-03", quality: "forecast", weatherCode: 2, temperatureMin: 18, temperatureMax: 26, precipitationProbability: 25, fetchedAt: now.toISOString() },
        route: { distance: 6200, duration: 1800, quality: "routed", source: "OSRM", fetchedAt: now.toISOString() },
        items: [
          { id: "west-lake", name: "西湖", startTime: "09:00", endTime: "11:30", durationMin: 150, requiredByUser: true, openingHours: "全天开放", sourceName: "杭州西湖风景名胜区", fetchedAt: now.toISOString() },
          { id: "museum", name: "浙江省博物馆", startTime: "13:15", endTime: "15:15", durationMin: 120, fetchedAt: now.toISOString() },
        ],
        blocks: [
          { type: "attraction", item: { id: "west-lake", name: "西湖", startTime: "09:00", endTime: "11:30", durationMin: 150, requiredByUser: true }, startTime: "09:00", endTime: "11:30", durationMin: 150 },
          { type: "rest", label: "午餐与休息", startTime: "11:30", endTime: "12:45", durationMin: 75 },
          { type: "leg", from: "西湖", to: "浙江省博物馆", startTime: "12:45", endTime: "13:15", durationMin: 30, mcpTransport: { durationMin: 30, source: "高德地图 MCP", fetchedAt: now.toISOString() } },
          { type: "attraction", item: { id: "museum", name: "浙江省博物馆", startTime: "13:15", endTime: "15:15", durationMin: 120 }, startTime: "13:15", endTime: "15:15", durationMin: 120 },
          { type: "rest", label: "弹性时间 / 返回住宿地", startTime: "15:15", endTime: "15:45", durationMin: 30 },
        ],
      },
      {
        day: 2,
        date: "2026-10-04",
        weather: { date: "2026-10-04", quality: "forecast", weatherCode: 3, temperatureMin: 19, temperatureMax: 25, precipitationProbability: 45, fetchedAt: now.toISOString() },
        route: { distance: 3200, duration: 1200, quality: "routed", source: "OSRM", fetchedAt: now.toISOString() },
        items: [{ id: "lingyin", name: "灵隐寺", startTime: "09:00", endTime: "11:30", durationMin: 150, requiredByUser: true, fetchedAt: now.toISOString() }],
        blocks: [
          { type: "attraction", item: { id: "lingyin", name: "灵隐寺", startTime: "09:00", endTime: "11:30", durationMin: 150, requiredByUser: true }, startTime: "09:00", endTime: "11:30", durationMin: 150 },
          { type: "rest", label: "弹性时间 / 返回住宿地", startTime: "11:30", endTime: "12:00", durationMin: 30 },
        ],
      },
    ],
  };
}

function observation(value: string, fetchedAt: string, id: string): FactObservation {
  return { value, confidence: 0.9, source: { id, name: id, type: "official", url: null, fetchedAt, quality: "verified" } };
}

test("TravelFact detects conflicting observations and stale TTL", () => {
  assert.equal(resolveObservationStatus([
    observation("08:00-17:00", now.toISOString(), "official-a"),
    observation("09:00-18:00", now.toISOString(), "official-b"),
  ], "verified", FACT_TTL_MS.openingOfficial, now.getTime()), "conflicting");
  assert.equal(isStale("2026-08-20T00:00:00.000Z", FACT_TTL_MS.weather, now.getTime()), true);
});

test("Travel intelligence keeps crowd, hotness, seasonality and opening alerts as separate evidence", () => {
  const current = plan();
  current.daysPlan[0].items[0] = {
    ...current.daysPlan[0].items[0],
    crowd: { score: 78, label: "高风险", confidence: 0.63, source: "节假日与公开趋势风险模型", updatedAt: now.toISOString() },
    hotness: { score: 71, label: "近期热门", status: "predicted", confidence: 0.58, updatedAt: now.toISOString(), source: "近 7 天公开报道" },
    seasonality: { score: 86, state: "GOOD", label: "秋景适配", status: "predicted", confidence: 0.66, updatedAt: now.toISOString(), source: "近期时令报道" },
    openingStatus: { status: "conflicting", alert: "检测到官方来源相关公告：国庆期间预约入园", sourceUrl: "https://example.gov.cn/notice", updatedAt: now.toISOString() },
  };
  const facts = buildTravelFacts(current, profile, now);
  const crowd = facts.find((fact) => fact.subject === "西湖" && fact.field === "拥挤风险");
  const hotness = facts.find((fact) => fact.subject === "西湖" && fact.field === "趋势热度");
  const season = facts.find((fact) => fact.subject === "西湖" && fact.field === "时令适配");
  const opening = facts.find((fact) => fact.subject === "西湖" && fact.field === "开放状态提醒");
  assert.equal(crowd?.status, "predicted");
  assert.equal(crowd?.nature, "prediction");
  assert.ok(crowd?.fetchedAt);
  assert.ok(crowd?.expiresAt);
  assert.equal(hotness?.status, "predicted");
  assert.equal(hotness?.importance, "medium");
  assert.equal(season?.status, "predicted");
  assert.equal(opening?.status, "conflicting");
  assert.equal(opening?.sourceUrl, "https://example.gov.cn/notice");
});

test("Planner audit surfaces recent opening notices without deleting required attractions", () => {
  const pack = {
    profile: { city: "杭州", days: 1, dayStart: "09:00", dayEnd: "21:00" },
    spots: [{ id: "west-lake", name: "西湖", requiredByUser: true, openingHours: "08:00-22:00", openingAlert: "国庆预约公告" }],
    weather: [], hotel: null, unknowns: [],
  };
  const variant = (id: string) => ({ id, title: id, style: id, strategy: id, days: [{
    day: 1, theme: "湖区", returnHotelTime: "18:00", totalActivityMin: 120, totalTransportMin: 0,
    activities: [
      { type: "attraction" as const, spotId: "west-lake", startTime: "09:00", endTime: "11:00", durationMin: 120, reason: "必去", evidenceRefs: ["west-lake"] },
      { type: "meal" as const, label: "午餐", startTime: "11:30", endTime: "12:30", durationMin: 60, reason: "用餐", evidenceRefs: [] },
      { type: "rest" as const, label: "休息", startTime: "12:30", endTime: "13:00", durationMin: 30, reason: "缓冲", evidenceRefs: [] },
    ],
  }] });
  const audit = auditPlannerDraft({ variants: [variant("hot"), variant("niche"), variant("relax")] }, pack);
  assert.equal(audit.issues.filter((issue) => issue.code === "OPENING_ALERT_REVIEW").length, 3);
  assert.equal(audit.hardIssues.some((issue) => issue.code === "REQUIRED_MISSING"), false);
});

test("Unknown Analysis ranks required reservation before lower-impact unknowns", () => {
  const current = plan();
  const facts: TravelFact[] = [
    { id: "reservation", subject: "西湖", field: "预约状态", value: null, status: "unknown", sourceType: "none", sourceName: "未接入", sourceUrl: null, updatedAt: now.toISOString(), confidence: 0, importance: "high", uncertaintyReason: "无指定日期余量", downstreamImpact: "可能导致必选节点无法执行" },
    { id: "hotel", subject: "酒店", field: "价格", value: null, status: "unknown", sourceType: "none", sourceName: "未返回", sourceUrl: null, updatedAt: now.toISOString(), confidence: 0, importance: "low", uncertaintyReason: "无价格", downstreamImpact: "对当前路线影响有限" },
  ];
  const analysis = analyzeUnknowns(current, facts, now);
  assert.equal(analysis.criticalUnknown?.factId, "reservation");
  const verification = buildMinimumVerification(analysis, facts);
  assert.equal(verification[0].factId, "reservation");
  assert.ok(verification.length < facts.length || verification.at(-1)?.cumulativeRiskCoverage === 100);
});

test("Dependency graph, critical path and buffers are derived from itinerary nodes", () => {
  const current = plan();
  const graph = buildDependencyGraph(current, profile);
  const buffers = analyzeBuffers(current, profile);
  const criticalPath = calculateCriticalPath(graph);
  assert.ok(graph.nodes.some((node) => node.label === "西湖" && node.required));
  assert.ok(graph.edges.some((edge) => edge.relation === "travel"));
  assert.ok(criticalPath.nodeIds.length >= 2);
  assert.equal(buffers.daily.length, 2);
  assert.ok(buffers.minBufferMinutes >= 30);
});

test("Fragility and stress propagate through actual dependency nodes", () => {
  const current = plan();
  const graph = buildDependencyGraph(current, profile);
  const buffers = analyzeBuffers(current, profile);
  const unknowns = { count: 1, importantCount: 1, items: [], criticalUnknown: null };
  const fragility = analyzeFragility(current, graph, buffers, unknowns);
  const stress = runStressTest(graph, buffers);
  assert.ok(fragility.fixedNodeCount >= 2);
  assert.equal(stress.type, "simulation");
  assert.ok(stress.scenarios.every((scenario) => scenario.targetNodeId && scenario.affectedNodeIds.includes(scenario.targetNodeId)));
});

test("Minimum-disruption replan preserves unaffected days and emits node-level changes", () => {
  const before = plan();
  const proposed = structuredClone(before);
  proposed.daysPlan[0].items = [{ id: "botanical", name: "杭州植物园", startTime: "09:00", endTime: "11:00" }];
  proposed.daysPlan[1].items = [];
  const result = proposeReplan(before, proposed, [1]);
  assert.deepEqual(result.proposedPlan.daysPlan[1], before.daysPlan[1]);
  assert.equal(result.changeSet.preservedDays.includes(2), true);
  assert.ok(result.changeSet.added.some((change) => change.nodeId === "botanical"));
  assert.ok(result.changeSet.removed.some((change) => change.nodeId === "west-lake"));
  assert.equal(result.requiresConfirmation, true);
});

test("Version history is linear and restorable", () => {
  const first = appendItineraryVersion([], "trip-1", plan(), null, "初始方案", "agent", now.toISOString());
  const second = appendItineraryVersion(first, "trip-1", { ...plan(), title: "调整后方案" }, null, "局部调整", "user", now.toISOString());
  assert.equal(isLinearVersionHistory(second), true);
  assert.equal(restoreItineraryVersion(second, "trip-1-v1")?.summary, "初始方案");
});

test("Trust orchestrator produces evidence, compiler, unknown, fragility and stress modules", () => {
  const current = plan();
  const result = analyzePlanTrustV2(current, profile, now);
  assert.ok(result.travelFacts.length > 0);
  assert.ok(result.evidenceGraph.edges.some((edge) => edge.relation === "informs"));
  assert.equal(result.compiler.version, "2.0");
  assert.ok(result.dependencyGraph.nodes.length > current.daysPlan.length);
  assert.equal(result.stressTest.type, "simulation");
});
