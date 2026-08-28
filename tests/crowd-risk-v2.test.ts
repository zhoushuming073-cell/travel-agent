import test from "node:test";
import assert from "node:assert/strict";
import { crowdRiskForVisit, dateCrowdPressure, inferCrowdRole, predictCrowdRisk } from "../worker/domain/crowd-risk.ts";

const forecast = { quality: "forecast", precipitationProbability: 20, fetchedAt: new Date().toISOString() };

test("国庆热门地标给出高风险区间，而不是 Unknown 或实时人数", () => {
  const result = predictCrowdRisk({
    date: "2026-10-03",
    spot: { name: "北京故宫博物院", category: "博物馆" },
    weather: forecast,
    hotness: { score: 82, source: "公开趋势", updatedAt: new Date().toISOString() },
    rating: 4.8,
    socialMentions: 2,
  });
  assert.ok(result.score >= 78);
  assert.equal(result.modelVersion, "crowd-risk-v2");
  assert.equal(result.officialRealtime, false);
  assert.ok(result.forecastBand.low < result.forecastBand.high);
  assert.ok(result.evidenceCoverage >= 80);
  assert.match(result.action, /官方预约|限流/);
});

test("即使近期趋势缺失，也生成明确的低置信度基础预测", () => {
  const result = predictCrowdRisk({ date: "2026-09-08", spot: { name: "苏州平江路历史街区" } });
  assert.ok(Number.isFinite(result.score));
  assert.equal(result.confidenceLabel, "较低");
  assert.equal(result.evidenceCoverage, 35);
  assert.ok(result.factorContributions.some((item) => item.id === "calendar"));
});

test("雨天对室内替代需求和户外到访作相反修正", () => {
  const rainy = { quality: "forecast", precipitationProbability: 85, fetchedAt: new Date().toISOString() };
  const indoor = predictCrowdRisk({ date: "2026-09-09", spot: { name: "上海博物馆", category: "博物馆" }, weather: rainy });
  const outdoor = predictCrowdRisk({ date: "2026-09-09", spot: { name: "上海世纪公园", category: "公园" }, weather: rainy });
  assert.ok(indoor.factorContributions.some((item) => item.id === "weather" && item.direction === "up"));
  assert.ok(outdoor.factorContributions.some((item) => item.id === "weather" && item.direction === "down"));
  assert.ok(indoor.score > outdoor.score);
});

test("模型按景点语义识别合理峰谷时段", () => {
  const bund = predictCrowdRisk({ date: "2026-09-09", spot: { name: "上海外滩", category: "夜景" }, weather: forecast });
  const temple = predictCrowdRisk({ date: "2026-09-09", spot: { name: "西安大兴善寺", category: "寺庙" }, weather: forecast });
  assert.equal(inferCrowdRole({ name: "上海外滩" }), "nightscape");
  assert.equal(bund.peakWindow, "18:00");
  assert.match(temple.recommendedWindow, /^08:00/);
});

test("最终排程使用实际到访日期和时间重新计算风险", () => {
  const base = predictCrowdRisk({ date: "2026-09-04", spot: { name: "成都人民公园", category: "公园" }, weather: forecast });
  const early = crowdRiskForVisit(base, "08:00", "2026-09-04", forecast)!;
  const weekendMidday = crowdRiskForVisit(base, "12:00", "2026-09-05", forecast)!;
  assert.ok(weekendMidday.score > early.score);
  assert.equal(weekendMidday.visitDate, "2026-09-05");
  assert.equal(weekendMidday.visitTime, "12:00");
  assert.ok(weekendMidday.factors.includes("到访日期与时段修正"));
});

test("日期压力区分暑期、普通周末和工作日", () => {
  assert.ok(dateCrowdPressure("2026-08-22").impact > dateCrowdPressure("2026-09-08").impact);
  assert.equal(dateCrowdPressure("2026-10-03").label, "国庆黄金周");
});
