import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { summarizeTrafficCoverage } from "../worker/domain/traffic-coverage.ts";
import { applyFinalTimelineSafetyRepair, poiImageScore, reflowDayAfterTransit } from "../worker/travel-api.ts";

const root = join(import.meta.dirname, "..");
const apiSource = readFileSync(join(root, "worker", "travel-api.ts"), "utf8");
const persistenceSource = readFileSync(join(root, "worker", "persistence.ts"), "utf8");
const frontendSource = readFileSync(join(root, "travel", "services", "planningApi.ts"), "utf8");
const cssSource = readFileSync(join(root, "app", "travel", "[[...tripId]]", "workspace-react.css"), "utf8");

test("complete planning uses resumable Sites requests instead of waitUntil", () => {
  assert.doesNotMatch(apiSource, /waitUntil\(executeDurablePlanningJob/);
  assert.match(apiSource, /\/api\/plan\/advance/);
  assert.match(apiSource, /nextIncompleteStage/);
  assert.match(frontendSource, /launchNextStage/);
  assert.match(frontendSource, /\/api\/plan\/advance/);
});

test("all three V4 Pro variants have independent durable D1 checkpoints", () => {
  for (const stage of ["variant_hot", "variant_niche", "variant_relax"]) assert.match(apiSource, new RegExp(`"${stage}"`));
  assert.match(apiSource, /putTravelJobArtifact\(jobId, stage/);
  assert.match(apiSource, /requestTimeoutMs: 150000/);
  assert.match(apiSource, /attempt:\$\{stage\}/);
  assert.match(apiSource, /结构校验失败后的最后一次定向重试/);
  assert.match(apiSource, /maxTokens: 5400/);
  assert.match(apiSource, /若明确要求“本次只生成某一套”/);
});

test("final compiler adds lunch, preserves required places and removes only flexible overtime stops", () => {
  const draft = { variants: [{ id: "hot", days: [{ day: 1, returnHotelTime: "22:30", activities: [
    { type: "attraction", spotId: "museum", label: "博物馆", startTime: "09:00", endTime: "13:00", durationMin: 240 },
    { type: "attraction", spotId: "garden", label: "花园", startTime: "13:00", endTime: "17:00", durationMin: 240 },
    { type: "attraction", spotId: "tower", label: "观景台", startTime: "16:00", endTime: "18:00", durationMin: 120 },
    { type: "attraction", spotId: "gallery", label: "画廊", startTime: "16:30", endTime: "18:30", durationMin: 120 },
    { type: "attraction", spotId: "pier", label: "码头", startTime: "17:00", endTime: "19:00", durationMin: 120 },
    { type: "meal", spotId: "peace", label: "和平饭店晚餐", startTime: "17:30", endTime: "19:00", durationMin: 90 },
    { type: "attraction", spotId: "bund", label: "外滩夜景", startTime: "19:00", endTime: "21:30", durationMin: 150 },
  ] }] }] };
  const knowledge = { profile: { dayStart: "09:00", dayEnd: "21:00" }, weather: [{ sunset: "18:10" }], trafficMatrix: { legs: [] }, spots: [
    { id: "museum", requiredByUser: false }, { id: "garden", requiredByUser: false }, { id: "tower", requiredByUser: false }, { id: "gallery", requiredByUser: false }, { id: "pier", requiredByUser: false },
    { id: "peace", requiredByUser: true, timeRole: "meal-landmark" }, { id: "bund", requiredByUser: true, timeRole: "nightscape" },
  ] };
  const repaired = applyFinalTimelineSafetyRepair(draft, knowledge);
  const activities = draft.variants[0].days[0].activities as Array<{ type: string; spotId?: string; label?: string; endTime: string }>;
  assert.equal(repaired.insertedLunches, 1);
  assert.ok(repaired.removedFlexibleStops >= 1);
  assert.ok(activities.some((item) => item.spotId === "peace"));
  assert.ok(activities.some((item) => item.spotId === "bund"));
  assert.ok(activities.some((item) => item.type === "meal" && item.label?.includes("午餐")));
  assert.ok(activities.every((item) => Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3)) <= 21 * 60));
});

test("final transit requires dinner only for an actual evening itinerary and inserts it before validation", () => {
  const earlyDay = {
    day: 1, date: "2026-08-30", weather: {}, items: [],
    blocks: [
      { type: "rest", mealType: "lunch", label: "午餐", startTime: "12:00", endTime: "13:00", durationMin: 60 },
      { type: "attraction", item: { id: "museum", name: "天津博物馆", lat: 39.08, lng: 117.22 }, startTime: "14:00", endTime: "17:30", durationMin: 210 },
    ],
  };
  assert.doesNotThrow(() => reflowDayAfterTransit(earlyDay, { dayStart: "09:00", dayEnd: "21:00" }));
  assert.equal(earlyDay.blocks.some((block: { mealType?: string }) => block.mealType === "dinner"), false);

  const eveningDay = {
    day: 1, date: "2026-08-30", weather: { sunset: "18:31" }, items: [],
    blocks: [
      { type: "rest", mealType: "lunch", label: "午餐", startTime: "12:00", endTime: "13:00", durationMin: 60 },
      { type: "attraction", item: { id: "eye", name: "天津之眼", lat: 39.15, lng: 117.20 }, startTime: "14:00", endTime: "19:00", durationMin: 300 },
    ],
  };
  assert.doesNotThrow(() => reflowDayAfterTransit(eveningDay, { dayStart: "09:00", dayEnd: "21:00" }));
  assert.ok(eveningDay.blocks.some((block: { mealType?: string }) => block.mealType === "dinner"));
});

test("D1 runtime persists leases, artifacts, events and provider attempts", () => {
  for (const value of ["travel_job_artifacts", "travel_job_events", "travel_job_provider_attempts", "lease_nonce", "heartbeat_at", "cancel_requested_at"]) assert.match(persistenceSource, new RegExp(value));
  assert.match(apiSource, /renewTravelJobLease/);
  assert.match(apiSource, /TASK_CANCELLED/);
  assert.match(apiSource, /LEASE_LOST/);
});

test("browser task recovery uses HttpOnly cookie, active lookup and real server cancellation", () => {
  assert.match(apiSource, /Secure; HttpOnly; SameSite=Strict/);
  assert.match(apiSource, /\/api\/plan\/active/);
  assert.match(apiSource, /\/api\/plan\/cancel/);
  assert.match(frontendSource, /sessionStorage\.setItem/);
  assert.match(frontendSource, /reconnectPlanningJob/);
  assert.match(frontendSource, /cancelPlanningJob/);
  assert.match(apiSource, /站内断点执行器/);
  assert.match(apiSource, /expireStaleTravelJobs/);
  assert.match(frontendSource, /CONCURRENT_JOB_LIMIT/);
  assert.match(frontendSource, /pollPlanningJob\(error\.jobId/);
  assert.match(apiSource, /\/api\/plan\/retry/);
  assert.match(frontendSource, /retryPlanningJob/);
  assert.match(persistenceSource, /resetTravelJobForRetry/);
});

test("deterministic final validation errors do not repeat the same unchanged stage three times", () => {
  assert.match(apiSource, /const deterministicFailure =/);
  assert.match(apiSource, /deterministicFailure \? 1/);
  assert.match(apiSource, /STAGE_VALIDATION_FAILED/);
});

test("model failures degrade safely instead of multiplying calls or killing the whole trip", () => {
  assert.match(apiSource, /!\/联通元景\/\.test\(source\)/);
  assert.match(apiSource, /结构化重规划复用（未重复调用模型）/);
  assert.match(apiSource, /MODEL_STRUCTURE_RECOVERED/);
  assert.match(apiSource, /recoverPlannerVariant/);
  assert.match(apiSource, /compactPlannerKnowledge/);
  assert.match(persistenceSource, /STALE_TASK_REPLACED/);
});

test("traffic coverage transparently distinguishes verified and estimated legs", () => {
  assert.deepEqual(summarizeTrafficCoverage(342, 25), { total: 342, verified: 25, estimated: 317, coveragePercent: 7.3, status: "degraded" });
  assert.equal(summarizeTrafficCoverage(10, 8).status, "target-met");
  assert.match(apiSource, /\.slice\(0, 6\)/);
  assert.match(apiSource, /finalTransitCoverage < 60/);
});

test("parent scenic entities outrank narrow child entities for images", () => {
  const wanted = ["豫园"];
  assert.ok(poiImageScore({ name: "豫园", type: "风景名胜" }, wanted) > poiImageScore({ name: "豫园内园", type: "风景名胜" }, wanted));
  assert.ok(poiImageScore({ name: "田子坊", type: "风景名胜" }, ["田子坊"]) > poiImageScore({ name: "田子坊艺术中心", type: "科教文化服务" }, ["田子坊"]));
  assert.match(apiSource, /distanceM <= 1200/);
  assert.match(apiSource, /spot-image-v29/);
});

test("favicon and mobile horizontal discovery hint are shipped", () => {
  assert.ok(statSync(join(root, "public", "favicon.ico")).size > 100);
  assert.match(cssSource, /quick-param-swipe-hint/);
  assert.match(cssSource, /linear-gradient/);
});
