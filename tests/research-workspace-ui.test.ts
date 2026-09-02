import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("location motion is owned by the selected itinerary map point", async () => {
  const [profile, map, ready] = await Promise.all([
    source("travel/components/RequirementProfile.tsx"),
    source("travel/components/MapPanel.tsx"),
    source("travel/components/ReadyDashboard.tsx"),
  ]);
  assert.doesNotMatch(profile, /MOTION\.location/);
  assert.match(map, /selected \? <LottieMotion src=\{MOTION\.location\}/);
  assert.match(map, /aria-pressed=\{selected\}/);
  assert.match(ready, /useState<string \| null>\(null\)/);
});

test("research stage uses paced evidence cards and never swaps to a success animation", async () => {
  const research = await source("travel/components/DataAcquisition.tsx");
  const dwell = Number(research.match(/MIN_CARD_DWELL_MS = (\d+)/)?.[1]);
  assert.ok(dwell >= 3000, `card dwell ${dwell}ms is too short`);
  assert.match(research, /src=\{MOTION\.search\}/);
  assert.doesNotMatch(research, /MOTION\.success/);
  assert.doesNotMatch(research, /原始需求|实时任务/);
  assert.match(research, /实时取证快照/);
  assert.match(research, /不是预制搜索结果/);
  assert.match(research, /source\?\.provider/);
  assert.match(research, /source\?\.detail/);
  assert.match(research, /fallbackMode="error-only"/);
});

test("primary stage animations never flash a loading placeholder", async () => {
  const [profile, motion, styles, layout] = await Promise.all([
    source("travel/components/RequirementProfile.tsx"),
    source("travel/components/LottieMotion.tsx"),
    source("app/travel/[[...tripId]]/styles/motion.css"),
    source("app/layout.tsx"),
  ]);
  assert.match(profile, /face-scanning\.json[^\n]+fallbackMode="error-only"/);
  assert.match(motion, /fallbackMode === "loading-and-error"/);
  assert.match(motion, /readySrc === src/);
  assert.match(styles, /\.lottie-canvas[^}]+visibility:\s*hidden/);
  assert.match(styles, /\.lottie-motion\.is-ready > \.lottie-canvas[^}]+visibility:\s*visible/);
  assert.match(layout, /preload[^\n]+face-scanning\.json/);
  assert.match(layout, /preload[^\n]+search\.json/);
});

test("crowd prediction stays explainable, time-aware and mobile friendly", async () => {
  const [panels, timeline, styles] = await Promise.all([
    source("travel/components/dashboard/EnvironmentPanels.tsx"),
    source("travel/components/ItineraryTimeline.tsx"),
    source("app/travel/[[...tripId]]/styles/dashboard.css"),
  ]);
  for (const text of ["0–100 风险指数", "预测不等于实时人流", "推荐", "次推荐", "尽量避开", "查看预测依据", "官方/外部数据", "公开趋势", "规则/模型预测"]) {
    assert.match(panels, new RegExp(text));
  }
  assert.match(panels, /value\.timeWindows/);
  assert.match(panels, /value\.visitAdvice/);
  assert.doesNotMatch(panels, /实时游客|当前园内人数|实时拥挤度/);
  assert.match(timeline, /计划时段人流预测/);
  assert.match(styles, /\.crowd-day-trend/);
  assert.match(styles, /@media \(max-width:620px\)[\s\S]+\.crowd-window-grid \{ grid-template-columns:1fr;/);
});
