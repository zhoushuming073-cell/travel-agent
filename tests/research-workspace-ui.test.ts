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
});
