export type CrowdRole = "nightscape" | "meal-landmark" | "timed-indoor" | "religious" | "theme-park" | "broad-outdoor" | "heritage-core" | "flexible";

export interface CrowdFactorContribution {
  id: string;
  label: string;
  impact: number;
  direction: "up" | "down" | "neutral";
  evidence: string;
  nature: "calendar" | "place-prior" | "forecast" | "public-trend" | "map-signal";
}

export interface CrowdPredictionInput {
  date: string;
  spot: { name?: string; officialName?: string; category?: string; type?: string };
  weather?: { quality?: string; date?: string; precipitationProbability?: number; temperatureMax?: number; temperatureMin?: number; fetchedAt?: string } | null;
  hotness?: { score?: number | null; updatedAt?: string; source?: string } | null;
  rating?: number | null;
  socialMentions?: number;
  updatedAt?: string;
}

export interface CrowdRiskPrediction {
  score: number;
  riskProbability: number;
  label: string;
  confidence: number;
  confidenceLabel: "较高" | "中等" | "较低";
  evidenceCoverage: number;
  uncertainty: "low" | "medium" | "high";
  factors: string[];
  factorContributions: CrowdFactorContribution[];
  forecastBand: { low: number; high: number };
  baseDate: string;
  visitDate?: string;
  visitTime?: string;
  modelVersion: "crowd-risk-v2";
  nature: "prediction";
  officialRealtime: false;
  freshnessHours: number | null;
  crowdRole: CrowdRole;
  baseWeatherRainProbability: number | null;
  timeWindows: Array<{ time: string; score: number; label: string; delta: number }>;
  recommendedWindow: string;
  recommendedWindows: string[];
  avoidWindow: string;
  peakWindow: string;
  action: string;
  comparableDateAnalysis?: { sampleCount: number; weightedRelevance: number; evidenceIds: string[]; note: string };
}

export interface ComparableCrowdSignal {
  sampleDate?: string | null;
  sampleTime?: string | null;
  evidenceId: string;
  sourceTier?: string;
  queueSeverity?: "low" | "medium" | "high" | "unknown";
  weatherSimilarity?: number;
  isHoliday?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

const labelFor = (score: number) => score >= 78 ? "很高" : score >= 60 ? "高" : score >= 38 ? "中" : "低";

function textFor(spot: CrowdPredictionInput["spot"]) {
  return `${spot.name || ""} ${spot.officialName || ""} ${spot.category || ""} ${spot.type || ""}`;
}

export function inferCrowdRole(spot: CrowdPredictionInput["spot"]): CrowdRole {
  const text = textFor(spot);
  if (/饭店|餐厅|酒楼|餐馆|食府|茶楼|小吃/.test(text)) return "meal-landmark";
  if (/迪士尼|环球影城|欢乐谷|方特|乐园|海洋公园/.test(text)) return "theme-park";
  if (/外滩|夜景|夜游|灯光秀|天际线|观景台|电视塔/.test(text)) return "nightscape";
  if (/寺|庙|宫观|教堂|清真寺/.test(text)) return "religious";
  if (/博物馆|美术馆|纪念馆|展览馆|科技馆|故居|剧院/.test(text)) return "timed-indoor";
  if (/古镇|古城|历史街区|步行街|园林|巷|弄|长城|陵|宫|故宫|兵马俑/.test(text)) return "heritage-core";
  if (/湖|山|湿地|森林|草原|海滩|公园|植物园|风景区/.test(text)) return "broad-outdoor";
  return "flexible";
}

export function dateCrowdPressure(dateIso: string) {
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const monthDay = dateIso.slice(5);
  const weekend = [0, 6].includes(date.getDay());
  if (monthDay >= "10-01" && monthDay <= "10-07") return { impact: 30, label: "国庆黄金周" };
  if (monthDay >= "05-01" && monthDay <= "05-05") return { impact: 25, label: "五一假期" };
  if (monthDay >= "01-01" && monthDay <= "01-03") return { impact: 17, label: "元旦假期" };
  if ((monthDay >= "07-10" && monthDay <= "08-25") && weekend) return { impact: 17, label: "暑期周末" };
  if (monthDay >= "07-10" && monthDay <= "08-25") return { impact: 8, label: "暑期工作日" };
  return { impact: weekend ? 12 : 0, label: weekend ? "普通周末" : "普通工作日" };
}

function seasonBucket(dateIso: string) {
  const month = Number(dateIso.slice(5, 7));
  return month <= 2 || month === 12 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "autumn";
}

function holidayClass(dateIso: string) {
  const pressure = dateCrowdPressure(dateIso);
  return pressure.impact >= 25 ? "golden-week" : pressure.impact >= 17 ? "holiday" : pressure.impact >= 8 ? "weekend-or-peak" : "weekday";
}

export function comparableDateRelevance(targetDate: string, sampleDate?: string | null, weatherSimilarity = 0.5) {
  if (!sampleDate || !/^\d{4}-\d{2}-\d{2}$/.test(sampleDate)) return 0.22;
  const target = new Date(`${targetDate}T12:00:00+08:00`);
  const sample = new Date(`${sampleDate}T12:00:00+08:00`);
  if (!Number.isFinite(target.getTime()) || !Number.isFinite(sample.getTime())) return 0.22;
  const sameHolidayClass = holidayClass(targetDate) === holidayClass(sampleDate);
  const sameWeekendClass = [0, 6].includes(target.getDay()) === [0, 6].includes(sample.getDay());
  const sameSeason = seasonBucket(targetDate) === seasonBucket(sampleDate);
  const ageDays = Math.abs(target.getTime() - sample.getTime()) / 86_400_000;
  const recency = Math.max(0.25, Math.exp(-ageDays / 520));
  const score = 0.12 + (sameHolidayClass ? 0.32 : 0) + (sameWeekendClass ? 0.16 : 0) + (sameSeason ? 0.18 : 0) + Math.max(0, Math.min(1, weatherSimilarity)) * 0.1 + recency * 0.12;
  return Number(Math.max(0.05, Math.min(1, score)).toFixed(2));
}

export function calibrateCrowdWithResearch(base: CrowdRiskPrediction | null | undefined, targetDate: string, signals: ComparableCrowdSignal[]) {
  if (!base || !signals?.length) return base;
  const weighted = signals.map((signal) => ({ ...signal, relevance: comparableDateRelevance(targetDate, signal.sampleDate, signal.weatherSimilarity) }));
  const totalWeight = weighted.reduce((sum, signal) => sum + signal.relevance, 0);
  const severityValue = (severity: ComparableCrowdSignal["queueSeverity"]) => severity === "high" ? 82 : severity === "medium" ? 58 : severity === "low" ? 28 : 50;
  const evidenceEstimate = weighted.reduce((sum, signal) => sum + severityValue(signal.queueSeverity) * signal.relevance, 0) / Math.max(0.01, totalWeight);
  const influence = Math.min(0.38, totalWeight / (totalWeight + 3));
  const score = clamp(base.score * (1 - influence) + evidenceEstimate * influence, 4, 98);
  const averageRelevance = Number((totalWeight / weighted.length).toFixed(2));
  const confidence = Math.min(0.9, Number((base.confidence + Math.min(0.16, totalWeight * 0.025)).toFixed(2)));
  const halfBand = Math.max(7, Math.round((base.forecastBand.high - base.forecastBand.low) / 2 * (1 - Math.min(0.2, totalWeight * 0.03))));
  return {
    ...base,
    score,
    riskProbability: score,
    label: labelFor(score),
    confidence,
    confidenceLabel: confidence >= 0.72 ? "较高" as const : confidence >= 0.55 ? "中等" as const : "较低" as const,
    uncertainty: confidence >= 0.72 ? "low" as const : confidence >= 0.55 ? "medium" as const : "high" as const,
    evidenceCoverage: clamp(base.evidenceCoverage + Math.min(22, totalWeight * 4), 0, 95),
    forecastBand: { low: clamp(score - halfBand, 3, 97), high: clamp(score + halfBand, 3, 97) },
    factors: [...new Set([...base.factors, "可比日期公开信号修正"])],
    comparableDateAnalysis: {
      sampleCount: weighted.length,
      weightedRelevance: averageRelevance,
      evidenceIds: weighted.map((signal) => signal.evidenceId),
      note: "按节假日类型、星期属性、季节、天气相似度和时间距离加权；不是目标日实时人数",
    },
  };
}

function timeImpact(role: CrowdRole, minute: number) {
  if (role === "nightscape") return minute >= 18 * 60 && minute <= 20 * 60 ? 16 : minute < 16 * 60 ? -8 : 5;
  if (role === "meal-landmark") return (minute >= 11 * 60 + 30 && minute <= 13 * 60 + 30) || (minute >= 17 * 60 + 30 && minute <= 20 * 60) ? 15 : -8;
  if (role === "timed-indoor") return minute >= 10 * 60 && minute <= 15 * 60 ? 10 : minute < 9 * 60 + 30 ? -6 : 2;
  if (role === "religious") return minute < 9 * 60 ? -13 : minute <= 14 * 60 ? 11 : 1;
  if (role === "theme-park") return minute < 9 * 60 ? -7 : minute <= 16 * 60 ? 12 : 2;
  if (role === "heritage-core") return minute < 9 * 60 + 30 ? -11 : minute <= 15 * 60 ? 10 : minute >= 18 * 60 ? -5 : 1;
  if (role === "broad-outdoor") return minute < 9 * 60 + 30 ? -14 : minute <= 15 * 60 ? 9 : minute >= 19 * 60 ? -5 : -1;
  return minute < 9 * 60 + 30 ? -7 : minute <= 15 * 60 ? 6 : 0;
}

function latestFreshnessHours(input: CrowdPredictionInput) {
  const timestamps = [input.weather?.fetchedAt, input.hotness?.updatedAt]
    .map((value) => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return Math.max(0, Math.round((Date.now() - Math.max(...timestamps)) / 3_600_000));
}

function nonAdjacentLowest(windows: CrowdRiskPrediction["timeWindows"], count: number) {
  const result: CrowdRiskPrediction["timeWindows"] = [];
  for (const window of [...windows].sort((a, b) => a.score - b.score)) {
    const minute = Number(window.time.slice(0, 2)) * 60 + Number(window.time.slice(3));
    if (result.every((item) => Math.abs((Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3))) - minute) >= 90)) result.push(window);
    if (result.length >= count) break;
  }
  return result;
}

export function predictCrowdRisk(input: CrowdPredictionInput): CrowdRiskPrediction {
  const role = inferCrowdRole(input.spot);
  const text = textFor(input.spot);
  const factors: CrowdFactorContribution[] = [];
  let score = 26;
  const add = (factor: CrowdFactorContribution) => { score += factor.impact; factors.push(factor); };

  const date = dateCrowdPressure(input.date);
  add({ id: "calendar", label: date.label, impact: date.impact, direction: date.impact > 0 ? "up" : "neutral", evidence: `${input.date} 中国大陆出游日期先验`, nature: "calendar" });

  const landmark = /故宫|长城|兵马俑|西湖|灵隐寺|外滩|东方明珠|九寨沟|大熊猫|迪士尼|环球影城|布达拉宫|张家界|黄山/.test(text);
  if (landmark) add({ id: "landmark", label: "全国性热门地标", impact: 13, direction: "up", evidence: "高知名度景点需求先验", nature: "place-prior" });

  if (["timed-indoor", "religious", "heritage-core"].includes(role)) add({ id: "capacity", label: "空间/入口承载较受限", impact: 8, direction: "up", evidence: "依据景点类型推断，非官方容量数据", nature: "place-prior" });
  else if (role === "broad-outdoor") add({ id: "capacity", label: "大尺度户外空间", impact: -5, direction: "down", evidence: "依据景点类型推断，局部节点仍可能拥挤", nature: "place-prior" });
  else if (role === "theme-park") add({ id: "capacity", label: "强目的性乐园", impact: 9, direction: "up", evidence: "依据景点类型与排队特征推断", nature: "place-prior" });

  const rain = Number(input.weather?.precipitationProbability ?? 0);
  const isForecast = input.weather?.quality === "forecast";
  if (isForecast && rain >= 60) {
    const indoor = ["timed-indoor", "meal-landmark"].includes(role);
    add({ id: "weather", label: indoor ? "降雨下室内替代需求" : "降雨抑制户外到访", impact: indoor ? 8 : -8, direction: indoor ? "up" : "down", evidence: `到访日降雨概率 ${Math.round(rain)}%`, nature: "forecast" });
  } else if (isForecast) {
    add({ id: "weather", label: "天气未触发强修正", impact: 0, direction: "neutral", evidence: `到访日降雨概率 ${Math.round(rain)}%`, nature: "forecast" });
  }

  if (input.hotness?.score != null) {
    const impact = clamp((Number(input.hotness.score) - 35) * 0.17, 0, 11);
    add({ id: "trend", label: "近期公开关注信号", impact, direction: impact ? "up" : "neutral", evidence: `${input.hotness.source || "公开趋势"} · 指数 ${Math.round(Number(input.hotness.score))}`, nature: "public-trend" });
  }
  const socialMentions = Math.max(0, Number(input.socialMentions || 0));
  if (socialMentions > 0) {
    const impact = Math.min(10, socialMentions * 2);
    add({ id: "social", label: "可归因社交热榜提及", impact, direction: "up", evidence: `${socialMentions} 个可归因提及`, nature: "public-trend" });
  }
  if (Number(input.rating || 0) >= 4.5) add({ id: "rating", label: "地图高评分 POI", impact: 4, direction: "up", evidence: `地图评分 ${Number(input.rating).toFixed(1)}`, nature: "map-signal" });

  score = clamp(score, 6, 96);
  let evidenceCoverage = 35;
  if (isForecast) evidenceCoverage += 20;
  if (input.hotness?.score != null) evidenceCoverage += 20;
  if (socialMentions > 0) evidenceCoverage += 10;
  if (input.rating) evidenceCoverage += 5;
  evidenceCoverage = clamp(evidenceCoverage, 0, 90);
  const confidence = Math.min(0.84, Number((0.31 + evidenceCoverage * 0.0054).toFixed(2)));
  const confidenceLabel = confidence >= 0.72 ? "较高" : confidence >= 0.55 ? "中等" : "较低";
  const uncertainty = confidence >= 0.72 ? "low" : confidence >= 0.55 ? "medium" : "high";
  const halfBand = Math.round(8 + (1 - confidence) * 15);
  const timeWindows = Array.from({ length: 14 }, (_, index) => 8 + index).map((hour) => {
    const delta = timeImpact(role, hour * 60);
    const windowScore = clamp(score + delta, 4, 98);
    return { time: `${String(hour).padStart(2, "0")}:00`, score: windowScore, label: labelFor(windowScore), delta };
  });
  const recommended = nonAdjacentLowest(timeWindows, 2);
  const peak = [...timeWindows].sort((a, b) => b.score - a.score)[0];
  const recommendedWindows = recommended.map((item) => `${item.time}（${item.label} ${item.score}%）`);
  const action = score >= 60
    ? `优先 ${recommended[0]?.time || "较早时段"} 到达；临近出发复核官方预约/限流，风险仍高则启用同类型备选`
    : `优先 ${recommended[0]?.time || "较早时段"} 到达，并在出发前复核官方预约与临时公告`;

  return {
    score,
    riskProbability: score,
    label: labelFor(score),
    confidence,
    confidenceLabel,
    evidenceCoverage,
    uncertainty,
    factors: factors.filter((factor) => factor.impact !== 0).map((factor) => factor.label),
    factorContributions: factors,
    forecastBand: { low: clamp(score - halfBand, 3, 97), high: clamp(score + halfBand, 3, 97) },
    baseDate: input.date,
    modelVersion: "crowd-risk-v2",
    nature: "prediction",
    officialRealtime: false,
    freshnessHours: latestFreshnessHours(input),
    crowdRole: role,
    baseWeatherRainProbability: isForecast ? rain : null,
    timeWindows,
    recommendedWindow: recommendedWindows[0] || "暂无明显低谷",
    recommendedWindows,
    avoidWindow: `${peak.time}（${peak.label} ${peak.score}%）`,
    peakWindow: peak.time,
    action,
  };
}

export function crowdRiskForVisit(crowd: CrowdRiskPrediction | null | undefined, startTime: unknown, visitDate?: string, weather?: CrowdPredictionInput["weather"]) {
  if (!crowd?.score) return crowd;
  const rawTime = typeof startTime === "string" ? startTime : "10:00";
  const [hour = 10, minute = 0] = rawTime.split(":").map(Number);
  const visitMinute = hour * 60 + minute;
  const nearest = [...crowd.timeWindows].sort((a, b) => {
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return Math.abs(minutes(a.time) - visitMinute) - Math.abs(minutes(b.time) - visitMinute);
  })[0];
  const dateDelta = visitDate ? dateCrowdPressure(visitDate).impact - dateCrowdPressure(crowd.baseDate).impact : 0;
  const weatherImpact = (rainProbability: number | null) => {
    if (rainProbability == null || rainProbability < 60) return 0;
    return ["timed-indoor", "meal-landmark"].includes(crowd.crowdRole) ? 8 : -8;
  };
  const visitRain = weather?.quality === "forecast" ? Number(weather.precipitationProbability || 0) : null;
  const weatherDelta = weatherImpact(visitRain) - weatherImpact(crowd.baseWeatherRainProbability);
  const score = clamp(Number(nearest?.score ?? crowd.score) + dateDelta + weatherDelta, 4, 98);
  const halfBand = Math.max(8, Math.round((crowd.forecastBand.high - crowd.forecastBand.low) / 2));
  return {
    ...crowd,
    score,
    riskProbability: score,
    label: labelFor(score),
    forecastBand: { low: clamp(score - halfBand, 3, 97), high: clamp(score + halfBand, 3, 97) },
    visitTime: rawTime,
    visitDate: visitDate || crowd.baseDate,
    factors: [...crowd.factors.filter((factor) => factor !== "到访日期与时段修正"), "到访日期与时段修正"],
  };
}
