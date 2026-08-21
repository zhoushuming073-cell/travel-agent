import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPlannerContext,
  auditPlannerDraft,
  buildDifferenceMetrics,
  mergeDeterministicProfile,
  parseStrictJsonObject,
  preserveLockedDays,
  sanitizeHotelPrice,
  settleTravelProviders,
  type PlannerDraft,
  type PlannerKnowledgePack,
} from "../worker/domain/planner-v4.ts";

const profile = {
  city: "杭州",
  startDate: "2026-10-03",
  days: 4,
  nights: 3,
  partySize: 2,
  dayStart: "09:00",
  dayEnd: "21:00",
  preferences: ["自然", "摄影"],
  avoid: ["大型商场"],
  requiredAttractions: ["西湖", "灵隐寺"],
  pace: "轻松",
};

const spots = [
  { id: "west-lake", name: "西湖", requiredByUser: true, lat: 30.245, lng: 120.15, tags: ["自然", "摄影"] },
  { id: "lingyin", name: "灵隐寺", requiredByUser: true, lat: 30.24, lng: 120.10, tags: ["文化"] },
  { id: "botanical", name: "杭州植物园", lat: 30.26, lng: 120.12, tags: ["自然", "摄影"] },
  { id: "canal", name: "京杭大运河", lat: 30.30, lng: 120.16, tags: ["文化", "夜景"] },
  { id: "museum", name: "浙江省博物馆", lat: 30.25, lng: 120.14, tags: ["室内", "文化"] },
  { id: "wetland", name: "西溪湿地", lat: 30.27, lng: 120.06, tags: ["自然", "摄影"] },
];

const matrix = {
  source: "OSRM Table routed",
  fetchedAt: "2026-08-21T08:00:00.000Z",
  quality: "routed" as const,
  nodes: [{ id: "hotel", name: "西湖附近" }, ...spots.map(({ id, name }) => ({ id, name }))],
  legs: spots.flatMap((from, index) => spots.slice(index + 1).map((to) => ({
    fromId: from.id,
    toId: to.id,
    durationMin: 20 + index,
    distanceM: 3000 + index * 100,
    source: "OSRM Table routed",
    quality: "routed" as const,
    fetchedAt: "2026-08-21T08:00:00.000Z",
  }))),
};

const knowledge: PlannerKnowledgePack = {
  profile,
  spots,
  weather: [],
  hotel: { status: "unknown", candidates: [] },
  trafficMatrix: matrix,
  unknowns: ["官方实时客流", "指定日期酒店成交价"],
};

function day(day: number, spotIds: string[]) {
  const startHour = 9;
  const activities = [
    ...spotIds.map((spotId, index) => ({
      type: "attraction" as const,
      spotId,
      startTime: `${String(startHour + index * 3).padStart(2, "0")}:00`,
      endTime: `${String(startHour + index * 3 + 2).padStart(2, "0")}:00`,
      durationMin: 120,
      transportFromPrevious: index ? { mode: "公共交通", durationMin: 25, matrixKey: `${spotIds[index - 1]}->${spotId}` } : undefined,
      reason: "依据候选景点标签与交通矩阵",
      evidenceRefs: [spotId, "traffic-matrix"],
    })),
    { type: "meal" as const, startTime: "12:00", endTime: "13:00", durationMin: 60, label: "午餐与休息", reason: "正常用餐", evidenceRefs: [] },
    { type: "rest" as const, startTime: "17:00", endTime: "17:30", durationMin: 30, label: "弹性休息", reason: "轻松节奏", evidenceRefs: [] },
  ];
  return { day, theme: `第 ${day} 天`, activities, returnHotelTime: "19:00", totalActivityMin: 270, totalTransportMin: 25 };
}

function draft(): PlannerDraft {
  return {
    variants: [
      { id: "hot", title: "经典覆盖", style: "经典", strategy: "代表性优先", days: [day(1, ["west-lake"]), day(2, ["lingyin"]), day(3, ["canal"]), day(4, ["museum"])] },
      { id: "niche", title: "自然摄影", style: "摄影", strategy: "自然与光线优先", days: [day(1, ["west-lake", "botanical"]), day(2, ["lingyin"]), day(3, ["wetland"]), day(4, ["museum"])] },
      { id: "relax", title: "轻松避峰", style: "轻松", strategy: "少景点与大缓冲", days: [day(1, ["west-lake"]), day(2, ["lingyin"]), day(3, ["wetland"]), day(4, ["canal"])] },
    ],
  };
}

test("planner is rejected before a real traffic matrix exists", () => {
  assert.throws(() => assertPlannerContext({ ...knowledge, trafficMatrix: undefined }), /交通矩阵/);
  assert.doesNotThrow(() => assertPlannerContext(knowledge));
});

test("all three variants keep required attractions, stay in time range, and include meals/rest", () => {
  const result = auditPlannerDraft(draft(), knowledge);
  assert.equal(result.hardIssues.length, 0, result.issues.map((issue) => issue.message).join("; "));
});

test("missing required attraction and opening conflict request a repair call", () => {
  const value = draft();
  value.variants[1].days[1].activities = value.variants[1].days[1].activities.filter((item) => item.spotId !== "lingyin");
  const pack = { ...knowledge, spots: spots.map((spot) => spot.id === "west-lake" ? { ...spot, openingHours: "10:00-17:00" } : spot) };
  value.variants[0].days[0].activities[0].startTime = "09:00";
  const result = auditPlannerDraft(value, pack);
  assert.ok(result.issues.some((issue) => issue.code === "REQUIRED_MISSING"));
  assert.ok(result.issues.some((issue) => issue.code === "OPENING_CONFLICT"));
  assert.equal(result.needsRepair, true);
});

test("variant difference metrics reject name-only alternatives", () => {
  const identical = draft();
  identical.variants[1].days = structuredClone(identical.variants[0].days);
  identical.variants[2].days = structuredClone(identical.variants[0].days);
  assert.ok(buildDifferenceMetrics(identical).maxJaccard > 0.9);
  assert.ok(auditPlannerDraft(identical, knowledge).issues.some((issue) => issue.code === "VARIANTS_TOO_SIMILAR"));
});

test("deterministic fields override extraction without promoting preferences to must-go", () => {
  const merged = mergeDeterministicProfile(
    { city: "杭州", startDate: "2026-10-03", days: 4, requiredAttractions: ["西湖", "灵隐寺"] },
    { city: "上海", startDate: "2026-10-04", days: 3, requiredAttractions: ["西湖", "杭州植物园"], preferences: ["杭州植物园"] },
  );
  assert.equal(merged.city, "杭州");
  assert.equal(merged.days, 4);
  assert.deepEqual(merged.requiredAttractions, ["西湖", "灵隐寺"]);
});

test("Unknown and missing hotel prices are never upgraded or invented", () => {
  assert.equal(sanitizeHotelPrice(undefined), null);
  assert.equal(sanitizeHotelPrice("待询价"), null);
  assert.equal(sanitizeHotelPrice("¥688"), 688);
  assert.ok(knowledge.unknowns.includes("官方实时客流"));
});

test("a timed-out provider does not fail the whole provider bundle", async () => {
  const result = await settleTravelProviders({
    weather: Promise.resolve({ source: "weather" }),
    hotels: Promise.reject(new Error("timeout")),
    spots: Promise.resolve(spots),
  });
  assert.equal(result.weather.status, "ready");
  assert.equal(result.hotels.status, "unavailable");
  assert.equal(result.spots.status, "ready");
});

test("local replan keeps every locked day byte-for-byte stable", () => {
  const before = draft().variants[2];
  const proposed = structuredClone(before);
  proposed.days[0].theme = "不应保留";
  proposed.days[1].theme = "第二天下午更轻松";
  const result = preserveLockedDays(before, proposed, [2]);
  assert.deepEqual(result.days[0], before.days[0]);
  assert.deepEqual(result.days[2], before.days[2]);
  assert.deepEqual(result.days[3], before.days[3]);
  assert.equal(result.days[1].theme, "第二天下午更轻松");
});

test("invalid DeepSeek JSON is rejected instead of reaching the frontend", () => {
  assert.throws(() => parseStrictJsonObject("not-json"), /有效 JSON/);
  assert.deepEqual(parseStrictJsonObject('{"variants":[]}'), { variants: [] });
});
