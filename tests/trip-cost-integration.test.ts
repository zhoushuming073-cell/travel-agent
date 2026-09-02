import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const api = readFileSync(join(root, "worker", "travel-api.ts"), "utf8");
const research = readFileSync(join(root, "worker", "domain", "research-planner.ts"), "utf8");
const overview = readFileSync(join(root, "travel", "components", "dashboard", "TripOverview.tsx"), "utf8");
const budgetPanel = readFileSync(join(root, "travel", "components", "dashboard", "BudgetPanel.tsx"), "utf8");
const dashboardCss = readFileSync(join(root, "app", "travel", "[[...tripId]]", "styles", "dashboard.css"), "utf8");

test("final compiler calculates each variant with deterministic Trip Cost V1", () => {
  assert.match(api, /for \(let variantIndex = 0; variantIndex < 3;/);
  assert.match(api, /const budgetBreakdown = estimateTripCost\(/);
  assert.match(api, /plan: \{ id: variantId, city: city\.name, daysPlan, hotelPlan: hotel \}/);
  assert.doesNotMatch(api, /transportEstimate.*2\.2/);
});

test("planner and research treat user budget as a decision constraint", () => {
  assert.match(api, /profile\.budget 是真实用户约束/);
  assert.match(api, /不得删除 requiredByUser 景点/);
  assert.match(api, /BUDGET_OVER/);
  assert.match(research, /"ticket_policy"/);
  assert.match(research, /门票或免费政策会影响用户总预算/);
});

test("dashboard exposes ranges, evidence nature, daily costs and calculation basis", () => {
  for (const text of ["旅行花销预测 V1", "预计余量", "预算可信度", "真实价格", "参考价格", "行程估算", "尚未核实", "每日可估费用", "不包含"]) assert.match(budgetPanel, new RegExp(text));
  assert.match(overview, /<BudgetPanel plan=\{plan\}/);
  assert.match(dashboardCss, /\.trip-budget-panel/);
  assert.match(dashboardCss, /@media \(max-width:900px\)/);
});
