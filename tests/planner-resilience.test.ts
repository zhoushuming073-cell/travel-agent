import test from "node:test";
import assert from "node:assert/strict";
import { compactPlannerKnowledge, enforceRequiredCoverage, normalizePlannerVariant, recoverPlannerVariant } from "../worker/travel-api.ts";

const profile = { city: "上海", startDate: "2026-09-03", days: 3, dayStart: "09:00", dayEnd: "21:00", pace: "relaxed" };

test("V4 Pro common alternate containers are normalized without discarding the plan", () => {
  const normalized = normalizePlannerVariant({ plan: { title: "摄影线", daysPlan: [
    { day: 1, items: [{ poiId: "bund", start: "18:30", end: "20:00", duration: 90 }] },
    { day: 2, schedule: [{ type: "meal", label: "午餐", startTime: "12:00", endTime: "13:00", durationMin: 60 }] },
    { day: 3, timeline: [{ placeId: "garden", startTime: "09:00", endTime: "10:30", durationMin: 90 }] },
  ] } }, profile, 1);
  assert.ok(normalized);
  assert.equal(normalized.days.length, 3);
  assert.equal(normalized.days[0].activities[0].spotId, "bund");
  assert.equal(normalized.days[2].activities[0].type, "attraction");
});

test("two failed model structures recover to a complete, auditable three-day timeline", () => {
  const spots = [
    { id: "peace", name: "和平饭店", requiredByUser: true, timeRole: "meal-landmark", plannerScore: 98 },
    { id: "bund", name: "外滩", requiredByUser: true, timeRole: "nightscape", plannerScore: 96 },
    { id: "museum", name: "上海博物馆", requiredByUser: false, timeRole: "timed-indoor", plannerScore: 88 },
    { id: "garden", name: "豫园", requiredByUser: false, timeRole: "heritage-core", plannerScore: 82 },
    { id: "park", name: "世纪公园", requiredByUser: false, timeRole: "broad-outdoor", plannerScore: 75 },
    { id: "tower", name: "东方明珠", requiredByUser: false, timeRole: "nightscape", plannerScore: 74 },
  ];
  const recovered = recoverPlannerVariant(profile, { profile, spots, weather: [{ sunset: "18:12" }, { sunset: "18:11" }, { sunset: "18:10" }] }, 0, { title: "模型半成品", days: [] }, "JSON 截断");
  assert.equal(recovered.days.length, 3);
  assert.ok(recovered.days.every((day: { activities: unknown[] }) => day.activities.length > 0));
  assert.ok(recovered.days.every((day: { activities: Array<{ type: string }> }) => day.activities.some((activity) => activity.type === "meal")));
  const used = recovered.days.flatMap((day: { activities: Array<{ spotId?: string }> }) => day.activities.map((activity) => activity.spotId).filter(Boolean));
  assert.ok(used.includes("peace"));
  assert.ok(used.includes("bund"));
  assert.match(recovered.strategy, /可靠性编译器/);
});

test("planner input compacts the full traffic matrix but preserves high-value legs", () => {
  const spots = Array.from({ length: 18 }, (_, index) => ({ id: `s${index}`, name: `景点${index}`, requiredByUser: index === 0 }));
  const nodes = [{ id: "hotel" }, ...spots];
  const legs = nodes.flatMap((from) => nodes.filter((to) => to.id !== from.id).map((to, index) => ({ fromId: from.id, toId: to.id, durationMin: index + 1 })));
  const compact = compactPlannerKnowledge({ spots, trafficMatrix: { legs, nodes, source: "test", fetchedAt: new Date().toISOString() } });
  assert.ok(compact.trafficMatrix.legs.length <= 120);
  assert.ok(compact.trafficMatrix.legs.some((leg: { fromId: string }) => leg.fromId === "hotel"));
  assert.ok(compact.trafficMatrix.legs.some((leg: { fromId: string; toId: string }) => leg.fromId === "s0" || leg.toId === "s0"));
  assert.equal(compact.trafficMatrix.totalCandidateLegs, legs.length);
  assert.equal(compact.trafficMatrix.compactedForModel, true);
});

test("hard-constraint compiler restores every user-required POI in every AI variant", () => {
  const required = [
    { id: "west-lake", name: "西湖", requiredByUser: true, timeRole: "daylight-outdoor", plannerScore: 100 },
    { id: "lingyin", name: "灵隐寺", requiredByUser: true, timeRole: "daylight-outdoor", plannerScore: 100 },
  ];
  const flexible = Array.from({ length: 6 }, (_, index) => ({ id: `optional-${index}`, name: `可选景点${index}`, requiredByUser: false, timeRole: "flexible", plannerScore: 60 + index }));
  const draft = {
    variants: ["hot", "niche", "relax"].map((id, variantIndex) => ({
      id, title: id, style: id, strategy: `AI ${id}`,
      days: [1, 2].map((day, dayIndex) => ({
        day, returnHotelTime: "17:00", activities: [
          { type: "attraction", spotId: flexible[variantIndex * 2 + dayIndex].id, startTime: "09:00", endTime: "10:30", durationMin: 90, reason: "AI选择" },
          { type: "meal", label: "午餐", startTime: "12:00", endTime: "13:00", durationMin: 60 },
        ],
      })),
    })),
  };
  const knowledge = { profile: { ...profile, city: "杭州", days: 2 }, spots: [...required, ...flexible], trafficMatrix: { legs: [], nodes: [] } };
  const result = enforceRequiredCoverage(draft, knowledge);
  assert.equal(result.replaced, 6);
  assert.equal(result.rebuilt, 0);
  for (const variant of draft.variants) {
    const ids = variant.days.flatMap((day) => day.activities.map((activity) => activity.spotId).filter(Boolean));
    assert.ok(ids.includes("west-lake"), `${variant.id} should include 西湖`);
    assert.ok(ids.includes("lingyin"), `${variant.id} should include 灵隐寺`);
    assert.match(variant.strategy, /^AI /, "AI strategy remains the route's design basis");
  }
});
