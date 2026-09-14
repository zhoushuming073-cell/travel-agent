import assert from "node:assert/strict";
import test from "node:test";

import { auditPlannerDraft, type PlannerDraft, type PlannerKnowledgePack } from "../worker/domain/planner-v4.ts";
import { estimatedRoadMinutes } from "../worker/domain/sparse-transit.ts";
import { bindTrafficMatrixFacts, legalizePlannerTimelines } from "../worker/planning/planner-normalization.ts";

function fixture(graphPolicy = "hotel-required-knn-lazy", coordinates = true) {
  const spots = [
    { id: "a", name: "甲景点", lat: 22.2800, lng: 114.1600, requiredByUser: true },
    { id: "b", name: "乙景点", lat: coordinates ? 22.3000 : undefined, lng: coordinates ? 114.1800 : undefined },
  ];
  const pack: PlannerKnowledgePack = {
    profile: { city: "香港", days: 1, dayStart: "09:00", dayEnd: "21:00", transport: "公共交通优先" },
    spots, weather: [], hotel: {}, unknowns: [],
    trafficMatrix: {
      source: "稀疏公共交通图", fetchedAt: "2026-09-14T00:00:00Z", quality: "estimated", graphPolicy,
      nodes: spots.map(({ id, name, lat, lng }) => ({ id, name, lat, lng })),
      legs: [{ fromId: "hotel", toId: "a", durationMin: 12, distanceM: 1800, quality: "estimated", source: "候选边", fetchedAt: "2026-09-14T00:00:00Z" }],
    },
  };
  const makeDay = () => ({
    day: 1, theme: "城市体验", returnHotelTime: "18:00", totalActivityMin: 180, totalTransportMin: 0,
    activities: [
      { type: "attraction" as const, spotId: "a", startTime: "09:00", endTime: "10:30", durationMin: 90, reason: "必去", evidenceRefs: [] },
      { type: "attraction" as const, spotId: "b", startTime: "10:35", endTime: "12:05", durationMin: 90, reason: "顺路", evidenceRefs: [] },
      { type: "meal" as const, label: "午餐", startTime: "12:30", endTime: "13:30", durationMin: 60, reason: "用餐", evidenceRefs: [] },
    ],
  });
  const draft: PlannerDraft = { variants: ["hot", "niche", "relax"].map((id) => ({
    id, title: id, style: id, strategy: id, days: [makeDay()],
  })) };
  return { pack, draft };
}

test("selected edges missing from the sparse graph are estimated once and audited with reserved travel time", () => {
  const { pack, draft } = fixture();
  bindTrafficMatrixFacts(draft, pack);
  const estimated = pack.trafficMatrix!.legs.filter((leg) => leg.fromId === "a" && leg.toId === "b");
  assert.equal(estimated.length, 1);
  assert.equal(estimated[0].quality, "estimated");
  assert.match(estimated[0].source, /待最终地图复核/);
  bindTrafficMatrixFacts(draft, pack);
  assert.equal(pack.trafficMatrix!.legs.filter((leg) => leg.fromId === "a" && leg.toId === "b").length, 1);
  legalizePlannerTimelines(draft, pack);
  for (const variant of draft.variants) {
    const second = variant.days[0].activities.find((activity) => activity.spotId === "b")!;
    assert.equal(second.transportFromPrevious?.durationMin, estimated[0].durationMin);
    assert.ok(second.startTime >= "10:30");
  }
  const codes = auditPlannerDraft(draft, pack).hardIssues.map((issue) => issue.code);
  assert.ok(!codes.includes("MATRIX_LEG_MISSING"));
  assert.ok(!codes.includes("TRANSIT_GAP"));
});

test("non-sparse or unlocated edges remain hard errors instead of becoming fabricated routes", () => {
  for (const [policy, coordinates] of [["complete", true], ["hotel-required-knn-lazy", false]] as const) {
    const { pack, draft } = fixture(policy, coordinates);
    bindTrafficMatrixFacts(draft, pack);
    assert.equal(pack.trafficMatrix!.legs.length, 1);
    assert.ok(auditPlannerDraft(draft, pack).hardIssues.some((issue) => issue.code === "MATRIX_LEG_MISSING"));
  }
});

test("fallback road estimate uses metres per minute without an accidental second division", () => {
  assert.equal(estimatedRoadMinutes(7800), 30);
});
