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
  assert.equal(result.evidenceCoverage, 32);
  assert.match(result.dataQualityNote, /参考数据有限/);
  assert.ok(result.factorContributions.some((item) => item.id === "day-type"));
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
  assert.match(temple.recommendedWindow, /^07:00/);
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
  assert.equal(dateCrowdPressure("2026-05-02").label, "五一假期");
  assert.equal(dateCrowdPressure("2026-09-20").label, "调休工作日");
});

test("五档人流等级覆盖较少到非常拥挤且都明确为预测", () => {
  const quiet = predictCrowdRisk({ date: "2026-09-08", spot: { name: "城市湿地公园", category: "公园" } });
  const ordinary = predictCrowdRisk({ date: "2026-09-12", spot: { name: "城市展览馆", category: "展览馆" }, weather: forecast });
  const extreme = predictCrowdRisk({ date: "2026-10-03", spot: { name: "上海迪士尼乐园", category: "主题乐园" }, hotness: { score: 95, source: "公开趋势" } });
  assert.equal(quiet.label, "较少");
  assert.ok(["一般", "较多"].includes(ordinary.label));
  assert.equal(extreme.label, "非常拥挤");
  for (const result of [quiet, ordinary, extreme]) {
    assert.equal(result.nature, "prediction");
    assert.equal(result.officialRealtime, false);
    assert.ok(result.score >= 0 && result.score <= 100);
  }
});

test("室内、户外、夜景与宗教景点使用不同分时时间范围", () => {
  const indoor = predictCrowdRisk({ date: "2026-09-09", spot: { name: "上海博物馆", category: "博物馆", openingHours: "09:00-17:00" }, weather: forecast });
  const outdoor = predictCrowdRisk({ date: "2026-09-09", spot: { name: "西溪湿地", category: "湿地公园" }, weather: forecast });
  const night = predictCrowdRisk({ date: "2026-09-09", spot: { name: "上海外滩", category: "夜景" }, weather: forecast });
  const temple = predictCrowdRisk({ date: "2026-09-09", spot: { name: "灵隐寺", category: "寺庙" }, weather: forecast });
  assert.deepEqual(indoor.timeWindows.map((item) => item.time), ["09:00", "10:30", "12:00", "14:00", "16:00"]);
  assert.notDeepEqual(outdoor.timeWindows.map((item) => item.time), indoor.timeWindows.map((item) => item.time));
  assert.equal(night.timeWindows.at(-1)?.time, "21:00");
  assert.equal(temple.timeWindows[0]?.time, "07:00");
  assert.match(outdoor.recommendedWindow, /^07:00–/);
  assert.ok(outdoor.secondaryRecommendedWindow);
  assert.ok(outdoor.avoidWindow);
});

test("明显高峰到访会给出更低人流时段建议但不改写行程", () => {
  const base = predictCrowdRisk({ date: "2026-10-03", spot: { name: "上海迪士尼乐园", category: "主题乐园" }, hotness: { score: 90, source: "公开趋势" } });
  const visit = crowdRiskForVisit(base, "13:30", "2026-10-03", forecast)!;
  assert.ok(visit.score >= 70);
  assert.ok(visit.visitAdvice);
  assert.equal(visit.visitTime, "13:30");
  assert.match(visit.visitAdvice?.message || "", /预计.*若改至.*下降约/);
  assert.ok(Number(visit.visitAdvice?.pressureDrop) >= 12);
});

test("同一普通景点上午与下午按角色峰谷产生不同预测", () => {
  const base = predictCrowdRisk({ date: "2026-09-08", spot: { name: "城市历史街区", category: "历史街区" }, weather: forecast });
  const morning = crowdRiskForVisit(base, "08:00", "2026-09-08", forecast)!;
  const afternoon = crowdRiskForVisit(base, "14:00", "2026-09-08", forecast)!;
  assert.ok(afternoon.score > morning.score);
  assert.notEqual(afternoon.label, morning.label);
});
