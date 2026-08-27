import assert from "node:assert/strict";
import test from "node:test";

import { deterministicProfileHints, mergeTravelProfile } from "../worker/domain/profile-extraction.ts";

const now = new Date("2026-08-25T02:00:00Z");

test("Shanghai colloquial input overrides default parameters", () => {
  const text = "两个人，玩三天，8.25出发，去上海，想去和平饭店和上海外滩";
  const merged = mergeTravelProfile(
    { city: "杭州", startDate: "", days: 5, partySize: 1, freeText: text },
    { city: "上海", days: 3, partySize: 2, requiredAttractions: ["和平饭店", "上海外滩"] },
    now,
  );
  assert.equal(merged.city, "上海");
  assert.equal(merged.startDate, "2026-08-25");
  assert.equal(merged.days, 3);
  assert.equal(merged.partySize, 2);
  assert.deepEqual(merged.requiredAttractions, ["和平饭店", "上海外滩"]);
  assert.equal(merged.fieldSources.startDate, "text-rule");
});

test("Beijing family and Chinese-number expressions are extracted", () => {
  const hints = deterministicProfileHints("一家三口，9月3日去北京玩四天，必须去颐和园和故宫", now);
  assert.equal(hints.city, "北京");
  assert.equal(hints.startDate, "2026-09-03");
  assert.equal(hints.days, 4);
  assert.equal(hints.partySize, 3);
  assert.deepEqual(hints.requiredAttractions, ["颐和园", "故宫"]);
});

test("Chengdu relative date and adult-child composition are extracted", () => {
  const hints = deterministicProfileHints("2大1小，明天去成都玩三天，喜欢熊猫和美食", now);
  assert.equal(hints.city, "成都");
  assert.equal(hints.startDate, "2026-08-26");
  assert.equal(hints.partySize, 3);
  assert.equal(hints.adults, 2);
  assert.equal(hints.children, 1);
  assert.equal(hints.days, 3);
});

test("Guangzhou numeric range calculates duration without a year", () => {
  const hints = deterministicProfileHints("8.28-8.30到广州旅行，四个人同行", now);
  assert.equal(hints.city, "广州");
  assert.equal(hints.startDate, "2026-08-28");
  assert.equal(hints.days, 3);
  assert.equal(hints.partySize, 4);
});

test("past yearless date rolls to the next year", () => {
  const hints = deterministicProfileHints("10月2日去西安玩两天", new Date("2026-10-05T02:00:00Z"));
  assert.equal(hints.startDate, "2027-10-02");
  assert.equal(hints.city, "西安");
  assert.equal(hints.days, 2);
});

test("Suzhou relaxed trip keeps text values ahead of conflicting form defaults", () => {
  const merged = mergeTravelProfile(
    { city: "重庆", startDate: "2026-09-01", days: 7, partySize: 6, deepReasoning: false, freeText: "9月12日去苏州玩两天，一个人，想去拙政园" },
    { city: "苏州", startDate: "2026-09-12", days: 2, partySize: 1, requiredAttractions: ["拙政园"] },
    now,
  );
  assert.equal(merged.city, "苏州");
  assert.equal(merged.startDate, "2026-09-12");
  assert.equal(merged.days, 2);
  assert.equal(merged.partySize, 1);
  assert.equal(merged.deepReasoning, false);
});

test("Harbin winter request extracts date, duration and must-go place", () => {
  const hints = deterministicProfileHints("两个人，2027年1月8日去哈尔滨玩四天，必须去冰雪大世界", now);
  assert.equal(hints.city, "哈尔滨");
  assert.equal(hints.startDate, "2027-01-08");
  assert.equal(hints.days, 4);
  assert.equal(hints.partySize, 2);
  assert.deepEqual(hints.requiredAttractions, ["冰雪大世界"]);
});
