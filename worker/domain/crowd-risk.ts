export type CrowdRole = "nightscape" | "meal-landmark" | "timed-indoor" | "religious" | "theme-park" | "broad-outdoor" | "heritage-core" | "flexible";
export type CrowdPredictionLabel = "较少" | "一般" | "较多" | "拥挤" | "非常拥挤";

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
  spot: { name?: string; officialName?: string; category?: string; type?: string; openingHours?: string | null };
  weather?: { quality?: string; date?: string; precipitationProbability?: number; temperatureMax?: number; temperatureMin?: number; fetchedAt?: string } | null;
  hotness?: { score?: number | null; updatedAt?: string; source?: string } | null;
  rating?: number | null;
  socialMentions?: number;
  updatedAt?: string;
}

export interface CrowdTimeWindow {
  time: string;
  endTime: string;
  score: number;
  label: CrowdPredictionLabel;
  delta: number;
}

export interface CrowdVisitAdvice {
  currentTime: string;
  currentScore: number;
  currentLabel: CrowdPredictionLabel;
  suggestedTime: string;
  suggestedWindow: string;
  suggestedScore: number;
  pressureDrop: number;
  message: string;
}

export interface CrowdRiskPrediction {
  score: number;
  crowdRiskScore: number;
  /** @deprecated use crowdRiskScore; retained only for persisted-plan compatibility */
  riskProbability: number;
  label: CrowdPredictionLabel;
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
  visitAdvice?: CrowdVisitAdvice;
  modelVersion: "crowd-risk-v2";
  nature: "prediction";
  officialRealtime: false;
  freshnessHours: number | null;
  crowdRole: CrowdRole;
  baseWeatherRainProbability: number | null;
  openingHours?: string | null;
  timeWindows: CrowdTimeWindow[];
  recommendedWindow: string;
  secondaryRecommendedWindow: string;
  recommendedWindows: string[];
  avoidWindow: string;
  peakWindow: string;
  action: string;
  dataQualityNote: string;
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

export const crowdLabelForScore = (score: number): CrowdPredictionLabel => score >= 85
  ? "非常拥挤"
  : score >= 70
    ? "拥挤"
    : score >= 55
      ? "较多"
      : score >= 35
        ? "一般"
        : "较少";

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

interface CalendarPeriod {
  start: string;
  end: string;
  label: string;
  impact: number;
}

// 2026 dates follow 国办发明电〔2025〕7号. Other years deliberately fall back to
// conservative fixed-date priors rather than pretending an adjusted-workday calendar is known.
const OFFICIAL_2026_HOLIDAYS: CalendarPeriod[] = [
  { start: "2026-01-01", end: "2026-01-03", label: "元旦假期", impact: 17 },
  { start: "2026-02-15", end: "2026-02-23", label: "春节假期", impact: 24 },
  { start: "2026-04-04", end: "2026-04-06", label: "清明假期", impact: 18 },
  { start: "2026-05-01", end: "2026-05-05", label: "五一假期", impact: 25 },
  { start: "2026-06-19", end: "2026-06-21", label: "端午假期", impact: 18 },
  { start: "2026-09-25", end: "2026-09-27", label: "中秋假期", impact: 18 },
  { start: "2026-10-01", end: "2026-10-07", label: "国庆黄金周", impact: 30 },
];

const OFFICIAL_2026_ADJUSTED_WORKDAYS = new Set(["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]);

function officialHoliday(dateIso: string): CalendarPeriod | null {
  if (dateIso.startsWith("2026-")) return OFFICIAL_2026_HOLIDAYS.find((period) => dateIso >= period.start && dateIso <= period.end) || null;
  const monthDay = dateIso.slice(5);
  if (monthDay >= "10-01" && monthDay <= "10-07") return { start: `${dateIso.slice(0, 4)}-10-01`, end: `${dateIso.slice(0, 4)}-10-07`, label: "国庆假期先验", impact: 27 };
  if (monthDay >= "05-01" && monthDay <= "05-05") return { start: `${dateIso.slice(0, 4)}-05-01`, end: `${dateIso.slice(0, 4)}-05-05`, label: "劳动节假期先验", impact: 23 };
  if (monthDay >= "01-01" && monthDay <= "01-03") return { start: `${dateIso.slice(0, 4)}-01-01`, end: `${dateIso.slice(0, 4)}-01-03`, label: "元旦假期先验", impact: 15 };
  return null;
}

function validDate(dateIso: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateIso) && Number.isFinite(new Date(`${dateIso}T12:00:00+08:00`).getTime());
}

export function dateCrowdPressure(dateIso: string) {
  if (!validDate(dateIso)) return { impact: 0, label: "日期信息不足" };
  const holiday = officialHoliday(dateIso);
  if (holiday) return { impact: holiday.impact, label: holiday.label };
  if (OFFICIAL_2026_ADJUSTED_WORKDAYS.has(dateIso)) return { impact: 0, label: "调休工作日" };
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const weekend = [0, 6].includes(date.getDay());
  const summer = dateIso.slice(5) >= "07-10" && dateIso.slice(5) <= "08-25";
  return {
    impact: (weekend ? 12 : 0) + (summer ? 5 : 0),
    label: summer ? (weekend ? "暑期周末" : "暑期工作日") : weekend ? "普通周末" : "普通工作日",
  };
}

function calendarContributions(dateIso: string): CrowdFactorContribution[] {
  const holiday = officialHoliday(dateIso);
  if (holiday) return [{ id: "holiday", label: holiday.label, impact: holiday.impact, direction: "up", evidence: `${dateIso} 法定节假日日期规则；2026 年使用国务院公布安排`, nature: "calendar" }];
  if (OFFICIAL_2026_ADJUSTED_WORKDAYS.has(dateIso)) return [{ id: "day-type", label: "调休工作日", impact: 0, direction: "neutral", evidence: `${dateIso} 为国务院公布的调休工作日`, nature: "calendar" }];
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const weekend = validDate(dateIso) && [0, 6].includes(date.getDay());
  const summer = dateIso.slice(5) >= "07-10" && dateIso.slice(5) <= "08-25";
  const result: CrowdFactorContribution[] = [{ id: "day-type", label: weekend ? "普通周末" : "普通工作日", impact: weekend ? 12 : 0, direction: weekend ? "up" : "neutral", evidence: `${dateIso} 星期属性`, nature: "calendar" }];
  if (summer) result.push({ id: "season", label: "暑期季节性出游", impact: 5, direction: "up", evidence: "暑期仅作为季节性规则先验，不代表真实客流观测", nature: "calendar" });
  return result;
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
  if (!sampleDate || !validDate(sampleDate)) return 0.22;
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

function sourceTierWeight(sourceTier?: string) {
  return sourceTier === "tier_1_official" ? 1 : sourceTier === "tier_2_professional" ? 0.88 : sourceTier === "tier_3_news" ? 0.76 : sourceTier === "tier_4_ugc" ? 0.58 : 0.5;
}

function timeImpact(role: CrowdRole, minute: number) {
  if (role === "nightscape") return minute >= 18 * 60 && minute <= 20 * 60 + 30 ? 16 : minute < 16 * 60 ? -8 : 5;
  if (role === "meal-landmark") return (minute >= 11 * 60 + 30 && minute <= 13 * 60 + 30) || (minute >= 17 * 60 + 30 && minute <= 20 * 60) ? 15 : -8;
  if (role === "timed-indoor") return minute >= 10 * 60 + 30 && minute <= 15 * 60 ? 10 : minute < 9 * 60 + 30 ? -6 : 2;
  if (role === "religious") return minute < 9 * 60 ? -13 : minute <= 14 * 60 ? 11 : 1;
  if (role === "theme-park") return minute < 9 * 60 ? -7 : minute <= 16 * 60 ? 12 : 2;
  if (role === "heritage-core") return minute < 9 * 60 + 30 ? -11 : minute <= 15 * 60 ? 10 : minute >= 17 * 60 ? -5 : 1;
  if (role === "broad-outdoor") return minute < 9 * 60 + 30 ? -14 : minute <= 15 * 60 ? 9 : minute >= 18 * 60 ? -5 : -1;
  return minute < 9 * 60 + 30 ? -7 : minute <= 15 * 60 ? 6 : 0;
}

function minutes(value: string) {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(value: number) {
  const normalized = Math.max(0, Math.min(23 * 60 + 59, value));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function roleTimes(role: CrowdRole) {
  if (role === "nightscape") return ["14:00", "16:00", "18:00", "19:30", "21:00"];
  if (role === "meal-landmark") return ["10:30", "12:00", "14:30", "17:30", "19:00", "21:00"];
  if (role === "timed-indoor") return ["09:00", "10:30", "12:00", "14:00", "16:00"];
  if (role === "religious") return ["07:00", "08:30", "10:00", "12:00", "14:00", "16:00"];
  if (role === "theme-park") return ["08:00", "09:30", "11:00", "13:30", "16:00", "18:30"];
  if (role === "heritage-core") return ["07:30", "09:00", "10:30", "12:30", "15:00", "17:00"];
  if (role === "broad-outdoor") return ["07:00", "08:30", "10:30", "13:00", "15:30", "17:30"];
  return ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"];
}

function roleVisitMinutes(role: CrowdRole) {
  return role === "theme-park" ? 120 : role === "broad-outdoor" || role === "heritage-core" ? 90 : 75;
}

function openingBounds(openingHours?: string | null) {
  const matches = String(openingHours || "").match(/(\d{1,2}):(\d{2})\s*[-–—至]\s*(\d{1,2}):(\d{2})/);
  if (!matches) return null;
  return { start: Number(matches[1]) * 60 + Number(matches[2]), end: Number(matches[3]) * 60 + Number(matches[4]) };
}

function scheduleTimes(role: CrowdRole, openingHours?: string | null) {
  const bounds = openingBounds(openingHours);
  const times = roleTimes(role);
  if (!bounds) return times;
  const filtered = times.filter((time) => minutes(time) >= bounds.start && minutes(time) + 45 <= bounds.end);
  return filtered.length >= 4 ? filtered : times;
}

function nonAdjacentLowest(windows: CrowdTimeWindow[], count: number) {
  const result: CrowdTimeWindow[] = [];
  for (const window of [...windows].sort((a, b) => a.score - b.score || minutes(a.time) - minutes(b.time))) {
    if (result.every((item) => Math.abs(minutes(item.time) - minutes(window.time)) >= 90)) result.push(window);
    if (result.length >= count) break;
  }
  return result;
}

function scheduleFor(score: number, role: CrowdRole, openingHours?: string | null) {
  const duration = roleVisitMinutes(role);
  const timeWindows = scheduleTimes(role, openingHours).map((time) => {
    const delta = timeImpact(role, minutes(time));
    const windowScore = clamp(score + delta, 0, 100);
    return { time, endTime: timeFromMinutes(minutes(time) + duration), score: windowScore, label: crowdLabelForScore(windowScore), delta };
  });
  const recommended = nonAdjacentLowest(timeWindows, 2);
  const peak = [...timeWindows].sort((a, b) => b.score - a.score || minutes(a.time) - minutes(b.time))[0];
  const format = (window?: CrowdTimeWindow) => window ? `${window.time}–${window.endTime}` : "暂无明显低谷";
  return {
    timeWindows,
    recommendedWindow: format(recommended[0]),
    secondaryRecommendedWindow: format(recommended[1]),
    recommendedWindows: recommended.map(format),
    avoidWindow: format(peak),
    peakWindow: peak?.time || "",
  };
}

function latestFreshnessHours(input: CrowdPredictionInput) {
  const timestamps = [input.weather?.fetchedAt, input.hotness?.updatedAt]
    .map((value) => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return Math.max(0, Math.round((Date.now() - Math.max(...timestamps)) / 3_600_000));
}

function weatherContribution(role: CrowdRole, rain: number, isForecast: boolean): CrowdFactorContribution | null {
  if (!isForecast) return null;
  if (rain < 60) return { id: "weather", label: "天气未触发强修正", impact: 0, direction: "neutral", evidence: `Open-Meteo 到访日降雨概率 ${Math.round(rain)}%`, nature: "forecast" };
  const indoor = ["timed-indoor", "meal-landmark"].includes(role);
  const mixed = ["religious", "heritage-core"].includes(role);
  const impact = indoor ? 8 : mixed ? -4 : -8;
  return { id: "weather", label: indoor ? "降雨下室内替代需求" : mixed ? "降雨轻度抑制半户外到访" : "降雨抑制户外到访", impact, direction: impact > 0 ? "up" : "down", evidence: `Open-Meteo 到访日降雨概率 ${Math.round(rain)}%`, nature: "forecast" };
}

function confidenceState(confidence: number) {
  return {
    confidenceLabel: confidence >= 0.72 ? "较高" as const : confidence >= 0.55 ? "中等" as const : "较低" as const,
    uncertainty: confidence >= 0.72 ? "low" as const : confidence >= 0.55 ? "medium" as const : "high" as const,
  };
}

export function calibrateCrowdWithResearch(base: CrowdRiskPrediction | null | undefined, targetDate: string, signals: ComparableCrowdSignal[]) {
  if (!base || !signals?.length) return base;
  const informative = signals.filter((signal) => signal.evidenceId && signal.queueSeverity && signal.queueSeverity !== "unknown");
  if (!informative.length) return base;
  const weighted = informative.map((signal) => ({
    ...signal,
    relevance: comparableDateRelevance(targetDate, signal.sampleDate, signal.weatherSimilarity) * sourceTierWeight(signal.sourceTier),
  }));
  const totalWeight = weighted.reduce((sum, signal) => sum + signal.relevance, 0);
  const severityValue = (severity: ComparableCrowdSignal["queueSeverity"]) => severity === "high" ? 82 : severity === "medium" ? 58 : 28;
  const evidenceEstimate = weighted.reduce((sum, signal) => sum + severityValue(signal.queueSeverity) * signal.relevance, 0) / Math.max(0.01, totalWeight);
  const influence = Math.min(0.34, totalWeight / (totalWeight + 3.4));
  const score = clamp(base.score * (1 - influence) + evidenceEstimate * influence, 0, 100);
  const averageRelevance = Number((totalWeight / weighted.length).toFixed(2));
  const confidence = Math.min(0.88, Number((base.confidence + Math.min(0.16, totalWeight * 0.03)).toFixed(2)));
  const halfBand = Math.max(7, Math.round((base.forecastBand.high - base.forecastBand.low) / 2 * (1 - Math.min(0.2, totalWeight * 0.03))));
  const schedule = scheduleFor(score, base.crowdRole, base.openingHours);
  const impact = score - base.score;
  return {
    ...base,
    ...schedule,
    score,
    crowdRiskScore: score,
    riskProbability: score,
    label: crowdLabelForScore(score),
    confidence,
    ...confidenceState(confidence),
    evidenceCoverage: clamp(base.evidenceCoverage + Math.min(22, totalWeight * 5), 0, 95),
    forecastBand: { low: clamp(score - halfBand, 0, 100), high: clamp(score + halfBand, 0, 100) },
    factors: [...new Set([...base.factors, "可比日期公开信号修正"])],
    factorContributions: [...base.factorContributions, { id: "comparable-dates", label: "可比日期公开信号", impact, direction: impact > 0 ? "up" as const : impact < 0 ? "down" as const : "neutral" as const, evidence: `${weighted.length} 个可比日期公开样本按来源等级、节假日、星期、季节、天气与时效加权`, nature: "public-trend" as const }],
    dataQualityNote: confidence < 0.55 ? "参考数据有限，预测置信度较低" : "预测综合了可比日期公开信号与基础规则",
    comparableDateAnalysis: {
      sampleCount: weighted.length,
      weightedRelevance: averageRelevance,
      evidenceIds: weighted.map((signal) => signal.evidenceId),
      note: "按来源等级、节假日类型、星期属性、季节、天气相似度和时间距离加权；不是目标日实时人数",
    },
  };
}

export function predictCrowdRisk(input: CrowdPredictionInput): CrowdRiskPrediction {
  const role = inferCrowdRole(input.spot);
  const text = textFor(input.spot);
  const factors: CrowdFactorContribution[] = [];
  let score = 26;
  const add = (factor: CrowdFactorContribution) => { score += factor.impact; factors.push(factor); };

  calendarContributions(input.date).forEach(add);

  const landmark = /故宫|长城|兵马俑|西湖|灵隐寺|外滩|东方明珠|九寨沟|大熊猫|迪士尼|环球影城|布达拉宫|张家界|黄山/.test(text);
  if (landmark) add({ id: "landmark", label: "全国性热门地标", impact: 13, direction: "up", evidence: "高知名度景点需求规则先验，不是到访人数观测", nature: "place-prior" });

  if (["timed-indoor", "religious", "heritage-core"].includes(role)) add({ id: "capacity", label: "空间/入口承载较受限", impact: 8, direction: "up", evidence: "依据景点类型推断，非官方容量数据", nature: "place-prior" });
  else if (role === "broad-outdoor") add({ id: "capacity", label: "大尺度户外空间", impact: -5, direction: "down", evidence: "依据景点类型推断，局部节点仍可能拥挤", nature: "place-prior" });
  else if (role === "theme-park") add({ id: "capacity", label: "强目的性乐园", impact: 9, direction: "up", evidence: "依据景点类型与常见排队模式推断", nature: "place-prior" });

  const rain = Number(input.weather?.precipitationProbability ?? 0);
  const isForecast = input.weather?.quality === "forecast";
  const weatherFactor = weatherContribution(role, rain, isForecast);
  if (weatherFactor) add(weatherFactor);

  if (input.hotness?.score != null) {
    const impact = clamp((Number(input.hotness.score) - 35) * 0.17, 0, 11);
    add({ id: "trend", label: "近期公开关注信号", impact, direction: impact ? "up" : "neutral", evidence: `${input.hotness.source || "公开趋势"} · 关注指数 ${Math.round(Number(input.hotness.score))}，不等于客流`, nature: "public-trend" });
  }
  const socialMentions = Math.max(0, Number(input.socialMentions || 0));
  if (socialMentions > 0) {
    const impact = Math.min(10, socialMentions * 2);
    add({ id: "social", label: "可归因社交热榜提及", impact, direction: "up", evidence: `${socialMentions} 个可归因公开提及，不等于在园人数`, nature: "public-trend" });
  }
  if (Number(input.rating || 0) >= 4.5) add({ id: "rating", label: "地图高评分 POI", impact: 4, direction: "up", evidence: `地图 POI 评分 ${Number(input.rating).toFixed(1)}，仅作热度辅助`, nature: "map-signal" });

  score = clamp(score, 0, 100);
  let evidenceCoverage = 32;
  if (isForecast) evidenceCoverage += 18;
  if (input.hotness?.score != null) evidenceCoverage += 20;
  if (socialMentions > 0) evidenceCoverage += 10;
  if (input.rating) evidenceCoverage += 5;
  evidenceCoverage = clamp(evidenceCoverage, 0, 90);
  const hasObservedSupport = input.hotness?.score != null || socialMentions > 0 || Boolean(input.rating);
  const rawConfidence = Number((0.31 + evidenceCoverage * 0.0054).toFixed(2));
  const confidence = Math.min(hasObservedSupport ? 0.84 : 0.52, rawConfidence);
  const halfBand = Math.round(8 + (1 - confidence) * 15);
  const schedule = scheduleFor(score, role, input.spot.openingHours);
  const action = score >= 70
    ? `优先 ${schedule.recommendedWindow} 到访；临近出发复核官方预约/限流，预测仍高则考虑同类型备选`
    : `优先 ${schedule.recommendedWindow} 到访，并在出发前复核官方预约与临时公告`;

  return {
    score,
    crowdRiskScore: score,
    riskProbability: score,
    label: crowdLabelForScore(score),
    confidence,
    ...confidenceState(confidence),
    evidenceCoverage,
    factors: factors.filter((factor) => factor.impact !== 0).map((factor) => factor.label),
    factorContributions: factors,
    forecastBand: { low: clamp(score - halfBand, 0, 100), high: clamp(score + halfBand, 0, 100) },
    baseDate: input.date,
    modelVersion: "crowd-risk-v2",
    nature: "prediction",
    officialRealtime: false,
    freshnessHours: latestFreshnessHours(input),
    crowdRole: role,
    baseWeatherRainProbability: isForecast ? rain : null,
    openingHours: input.spot.openingHours,
    ...schedule,
    action,
    dataQualityNote: confidence < 0.55 ? "参考数据有限，预测置信度较低" : "预测综合了可用外部信号与规则先验",
  };
}

function weatherImpact(role: CrowdRole, rainProbability: number | null) {
  if (rainProbability == null || rainProbability < 60) return 0;
  if (["timed-indoor", "meal-landmark"].includes(role)) return 8;
  if (["religious", "heritage-core"].includes(role)) return -4;
  return -8;
}

export function crowdRiskForVisit(crowd: CrowdRiskPrediction | null | undefined, startTime: unknown, visitDate?: string, weather?: CrowdPredictionInput["weather"]) {
  if (!crowd || !Number.isFinite(crowd.score)) return crowd;
  const rawTime = typeof startTime === "string" && /^\d{1,2}:\d{2}$/.test(startTime) ? startTime.padStart(5, "0") : "10:00";
  const dateDelta = visitDate ? dateCrowdPressure(visitDate).impact - dateCrowdPressure(crowd.baseDate).impact : 0;
  const visitRain = weather?.quality === "forecast" ? Number(weather.precipitationProbability || 0) : null;
  const weatherDelta = weatherImpact(crowd.crowdRole, visitRain) - weatherImpact(crowd.crowdRole, crowd.baseWeatherRainProbability);
  const adjustedBase = clamp(crowd.score + dateDelta + weatherDelta, 0, 100);
  const schedule = scheduleFor(adjustedBase, crowd.crowdRole, crowd.openingHours);
  const visitMinute = minutes(rawTime);
  const nearest = [...schedule.timeWindows].sort((a, b) => Math.abs(minutes(a.time) - visitMinute) - Math.abs(minutes(b.time) - visitMinute))[0];
  const score = clamp(Number(nearest?.score ?? adjustedBase), 0, 100);
  const halfBand = Math.max(8, Math.round((crowd.forecastBand.high - crowd.forecastBand.low) / 2));
  const best = schedule.timeWindows.find((window) => `${window.time}–${window.endTime}` === schedule.recommendedWindow) || [...schedule.timeWindows].sort((a, b) => a.score - b.score)[0];
  const pressureDrop = Math.max(0, score - Number(best?.score ?? score));
  const visitAdvice = score >= 70 && pressureDrop >= 12 && best
    ? {
      currentTime: rawTime,
      currentScore: score,
      currentLabel: crowdLabelForScore(score),
      suggestedTime: best.time,
      suggestedWindow: `${best.time}–${best.endTime}`,
      suggestedScore: best.score,
      pressureDrop,
      message: `${rawTime} 预计${crowdLabelForScore(score)}，若改至 ${best.time}，人流压力预计下降约 ${pressureDrop}%。`,
    }
    : undefined;
  const actualDate = visitDate || crowd.baseDate;
  const currentWeatherFactor = weatherContribution(crowd.crowdRole, Number(visitRain || 0), weather?.quality === "forecast");
  const factorContributions = [
    ...crowd.factorContributions.filter((factor) => !["holiday", "day-type", "season", "weather"].includes(factor.id)),
    ...calendarContributions(actualDate),
    ...(currentWeatherFactor ? [currentWeatherFactor] : []),
  ];
  return {
    ...crowd,
    ...schedule,
    score,
    crowdRiskScore: score,
    riskProbability: score,
    label: crowdLabelForScore(score),
    forecastBand: { low: clamp(score - halfBand, 0, 100), high: clamp(score + halfBand, 0, 100) },
    visitTime: rawTime,
    visitDate: actualDate,
    visitAdvice,
    action: visitAdvice?.message || crowd.action,
    factorContributions,
    factors: [...new Set([...factorContributions.filter((factor) => factor.impact !== 0).map((factor) => factor.label), "到访日期与时段修正"])],
  };
}
