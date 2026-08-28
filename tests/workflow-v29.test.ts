import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { summarizeTrafficCoverage } from "../worker/domain/traffic-coverage.ts";
import { poiImageScore } from "../worker/travel-api.ts";

const root = join(import.meta.dirname, "..");
const apiSource = readFileSync(join(root, "worker", "travel-api.ts"), "utf8");
const persistenceSource = readFileSync(join(root, "worker", "persistence.ts"), "utf8");
const workflowSource = readFileSync(join(root, "orchestrator", "src", "index.ts"), "utf8");
const frontendSource = readFileSync(join(root, "travel", "services", "planningApi.ts"), "utf8");
const cssSource = readFileSync(join(root, "app", "travel", "[[...tripId]]", "workspace-react.css"), "utf8");

test("complete planning no longer runs inside Sites waitUntil", () => {
  assert.doesNotMatch(apiSource, /waitUntil\(executeDurablePlanningJob/);
  assert.match(workflowSource, /extends WorkflowEntrypoint/);
  assert.match(workflowSource, /step\.do\(stage/);
});

test("all three V4 Pro variants have independent durable workflow checkpoints", () => {
  for (const stage of ["variant_hot", "variant_niche", "variant_relax"]) assert.match(workflowSource, new RegExp(`\\["${stage}"`));
  assert.match(apiSource, /putTravelJobArtifact\(jobId, stage/);
  assert.match(workflowSource, /"150 seconds"/);
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
