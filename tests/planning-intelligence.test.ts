import test from "node:test";
import assert from "node:assert/strict";
import { buildPreferenceProfile, scorePreferenceMatch } from "../worker/domain/preference-intelligence.ts";
import { calibrateCrowdWithResearch, comparableDateRelevance, predictCrowdRisk } from "../worker/domain/crowd-risk.ts";
import { optimizeRouteBuckets, precheckRouteFeasibility } from "../worker/domain/route-optimizer.ts";
import { buildResearchDecisionTrace, traceCoverage } from "../worker/domain/decision-trace.ts";

test("preference intelligence rewards natural photography and penalizes explicit shopping avoidance", () => {
  const profile = buildPreferenceProfile({ preferences: ["自然", "摄影"], avoid: ["商场", "拥挤"], crowdSensitivity: "high" });
  const lake = scorePreferenceMatch({ name: "西湖曲院风荷", category: "自然风景", tags: ["摄影"], crowd: { score: 42 } }, profile, "niche");
  const mall = scorePreferenceMatch({ name: "湖滨银泰商场", category: "大型商场", crowd: { score: 82 } }, profile, "niche");
  assert.ok(lake.score > mall.score);
  assert.ok(lake.matched.includes("自然"));
  assert.ok(mall.avoided.includes("商场"));
});

test("comparable crowd samples favor matching holiday, weekday class and season", () => {
  const nationalDay = comparableDateRelevance("2026-10-03", "2025-10-04", 0.8);
  const ordinaryMonday = comparableDateRelevance("2026-10-03", "2026-03-02", 0.8);
  assert.ok(nationalDay > ordinaryMonday);
  const base = predictCrowdRisk({ date: "2026-10-03", spot: { name: "灵隐寺" } });
  const calibrated = calibrateCrowdWithResearch(base, "2026-10-03", [{ evidenceId: "ugc-1", sampleDate: "2025-10-04", queueSeverity: "high", weatherSimilarity: 0.8 }]);
  assert.equal(calibrated?.comparableDateAnalysis?.sampleCount, 1);
  assert.match(calibrated?.comparableDateAnalysis?.note || "", /不是目标日实时人数/);
});

test("deterministic route recovery covers must-go spots and clusters by matrix cost", () => {
  const spots = [
    { id: "west", name: "西湖", requiredByUser: true, plannerScore: 100, lat: 30.25, lng: 120.15, tags: ["自然", "摄影"] },
    { id: "lingyin", name: "灵隐寺", requiredByUser: true, plannerScore: 100, lat: 30.24, lng: 120.10, tags: ["文化"] },
    { id: "xixi", name: "西溪湿地", plannerScore: 88, lat: 30.27, lng: 120.06, tags: ["自然", "摄影"], seasonFit: { score: 80 } },
    { id: "museum", name: "浙江省博物馆", plannerScore: 80, lat: 30.26, lng: 120.14, tags: ["文化"] },
    { id: "canal", name: "京杭大运河", plannerScore: 78, lat: 30.32, lng: 120.14, tags: ["夜景"] },
  ];
  const result = optimizeRouteBuckets({ profile: { days: 2, pace: "relaxed" }, knowledge: { spots, trafficMatrix: { legs: [] } }, objective: "relax" });
  assert.equal(result.diagnostics.requiredCovered, 2);
  assert.ok(result.selectedIds.includes("west"));
  assert.ok(result.selectedIds.includes("lingyin"));
  assert.equal(result.dayBuckets.length, 2);
});

test("route optimizer keeps score breakdown and schedules tight opening windows during insertion", () => {
  const spots = [
    { id: "late", name: "晚间街区", plannerScore: 72, scoreBreakdown: { preference: 72, poiQuality: 70, dataCompleteness: 70 }, openingHours: "10:00-22:00", recommendedDurationMin: 90, lat: 22.30, lng: 114.17 },
    { id: "early", name: "上午展馆", plannerScore: 68, scoreBreakdown: { preference: 68, poiQuality: 92, dataCompleteness: 88 }, openingHours: "09:00-11:00", recommendedDurationMin: 90, lat: 22.301, lng: 114.171 },
    { id: "a", name: "A", plannerScore: 30, openingHours: "09:00-21:00", lat: 22.31, lng: 114.18 },
    { id: "b", name: "B", plannerScore: 29, openingHours: "09:00-21:00", lat: 22.32, lng: 114.19 },
    { id: "c", name: "C", plannerScore: 28, openingHours: "09:00-21:00", lat: 22.33, lng: 114.20 },
  ];
  const result = optimizeRouteBuckets({ profile: { days: 1, dayStart: "09:00", dayEnd: "21:00" }, knowledge: { spots, trafficMatrix: { legs: [] } }, objective: "hot" });
  assert.ok(result.selectedIds.includes("early"), "scoreBreakdown should survive into objective ranking");
  assert.ok(result.dayBuckets[0].findIndex((spot) => spot.id === "early") < result.dayBuckets[0].findIndex((spot) => spot.id === "late"));
});

test("feasibility precheck rejects an impossible required opening window before model planning", () => {
  const result = precheckRouteFeasibility({
    profile: { days: 1, dayStart: "09:00", dayEnd: "18:00" },
    knowledge: { spots: [{ id: "fixed", name: "固定预约", requiredByUser: true, openingHours: "10:00-10:30", recommendedDurationMin: 90 }], trafficMatrix: { legs: [] } },
  });
  assert.equal(result.feasible, false);
  assert.equal(result.violations[0]?.code, "WINDOW_TOO_SHORT");
});

test("research-to-decision trace links user preference, facts, evidence and compiler constraints", () => {
  const plan = { id: "relax", daysPlan: [{ day: 1, items: [{ id: "lingyin", name: "灵隐寺", startTime: "07:30", endTime: "10:00", requiredByUser: true, matchedPreferences: ["文化"], crowd: { score: 58 }, plannerScore: 100 }], blocks: [] }] };
  const research = { facts: [{ id: "fact-opening", targetId: "lingyin", targetName: "灵隐寺", factType: "opening_hours", value: { open: "07:00", close: "18:00" }, status: "verified", confidence: 0.9, supportingEvidenceIds: ["official-1"], conflictingEvidenceIds: [], fetchedAt: new Date().toISOString() }] };
  const traces = buildResearchDecisionTrace(plan, research);
  assert.ok(traces.some((trace) => trace.factIds.includes("fact-opening") && trace.evidenceIds.includes("official-1")));
  assert.equal(traceCoverage(traces).coverage, 1);
});
