import { prioritizeResearchGaps, researchUtility, type AdaptiveResearchBudget } from "./research-budget.ts";
import { preferredSourceTiers } from "./research-policy.ts";
import type { ResearchGap, ResearchQuestionType, ResearchRequest, SkippedResearchItem, SynthesizedFact } from "./research-types.ts";

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const clamp01 = (value: unknown, fallback = 0) => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback));

interface GapProfile {
  city: string;
  startDate: string;
  days: number;
  requiredAttractions?: string[];
  preferences?: string[];
  crowdSensitivity?: string;
  seasonalNeeds?: string[];
  budget?: number;
}

interface GapSpot {
  id: string;
  name: string;
  requiredByUser?: boolean;
  openingHours?: string | null;
  openingStatus?: string | { status?: string };
  reservation?: { status?: string };
  timeRole?: string;
  crowdRisk?: { evidenceCoverage?: number; confidence?: number };
  crowd?: { evidenceCoverage?: number; confidence?: number };
  seasonFit?: { status?: string };
  category?: string;
  plannerScore?: number;
}

const FACT_DEFAULTS: Record<ResearchQuestionType, { impact: number; uncertainty: number; gain: number; cost: number; freshness: number; blocking?: boolean }> = {
  opening_hours: { impact: 0.96, uncertainty: 0.9, gain: 0.82, cost: 0.55, freshness: 0.9, blocking: true },
  special_opening_hours: { impact: 0.96, uncertainty: 0.92, gain: 0.78, cost: 0.7, freshness: 1, blocking: true },
  temporary_closure: { impact: 1, uncertainty: 0.8, gain: 0.72, cost: 0.65, freshness: 1, blocking: true },
  reservation: { impact: 0.9, uncertainty: 0.9, gain: 0.76, cost: 0.6, freshness: 0.95, blocking: true },
  ticket_policy: { impact: 0.82, uncertainty: 0.82, gain: 0.76, cost: 0.55, freshness: 0.8 },
  entrance: { impact: 0.68, uncertainty: 0.72, gain: 0.58, cost: 0.7, freshness: 0.5 },
  internal_route: { impact: 0.58, uncertainty: 0.72, gain: 0.6, cost: 0.75, freshness: 0.45 },
  visit_duration: { impact: 0.78, uncertainty: 0.7, gain: 0.67, cost: 0.6, freshness: 0.55 },
  best_visit_time: { impact: 0.78, uncertainty: 0.76, gain: 0.65, cost: 0.65, freshness: 0.7 },
  photography_time: { impact: 0.72, uncertainty: 0.72, gain: 0.61, cost: 0.7, freshness: 0.55 },
  sunset_experience: { impact: 0.65, uncertainty: 0.62, gain: 0.56, cost: 0.65, freshness: 0.8 },
  night_experience: { impact: 0.62, uncertainty: 0.7, gain: 0.6, cost: 0.65, freshness: 0.8 },
  seasonal_event: { impact: 0.72, uncertainty: 0.85, gain: 0.7, cost: 0.75, freshness: 1 },
  festival: { impact: 0.7, uncertainty: 0.82, gain: 0.68, cost: 0.75, freshness: 1 },
  flower_season: { impact: 0.76, uncertainty: 0.86, gain: 0.7, cost: 0.7, freshness: 1 },
  crowd_pattern: { impact: 0.86, uncertainty: 0.82, gain: 0.68, cost: 0.8, freshness: 1 },
  queue_pattern: { impact: 0.82, uncertainty: 0.84, gain: 0.64, cost: 0.8, freshness: 1 },
  holiday_crowd: { impact: 0.84, uncertainty: 0.72, gain: 0.58, cost: 0.7, freshness: 0.8 },
  weekend_crowd: { impact: 0.8, uncertainty: 0.8, gain: 0.65, cost: 0.75, freshness: 0.95 },
  weather_sensitivity: { impact: 0.58, uncertainty: 0.58, gain: 0.48, cost: 0.65, freshness: 0.6 },
  transit_change: { impact: 0.9, uncertainty: 0.8, gain: 0.64, cost: 0.85, freshness: 1, blocking: true },
  construction: { impact: 0.86, uncertainty: 0.82, gain: 0.62, cost: 0.8, freshness: 1, blocking: true },
  shuttle: { impact: 0.65, uncertainty: 0.74, gain: 0.62, cost: 0.75, freshness: 0.8 },
  local_access: { impact: 0.68, uncertainty: 0.72, gain: 0.62, cost: 0.75, freshness: 0.8 },
  recent_travel_feedback: { impact: 0.48, uncertainty: 0.78, gain: 0.55, cost: 0.8, freshness: 1 },
};

function gap(profile: GapProfile, spot: GapSpot, factType: ResearchQuestionType, overrides: Partial<ResearchGap> = {}): ResearchGap {
  const defaults = FACT_DEFAULTS[factType];
  return {
    id: `gap:${spot.id}:${factType}`,
    targetId: spot.id,
    targetName: spot.name,
    factType,
    currentStatus: "unknown",
    decisionImpact: clamp01(overrides.decisionImpact, defaults.impact),
    uncertainty: clamp01(overrides.uncertainty, defaults.uncertainty),
    expectedInformationGain: clamp01(overrides.expectedInformationGain, defaults.gain),
    researchCost: Math.max(0.15, Number(overrides.researchCost ?? defaults.cost)),
    freshnessNeed: clamp01(overrides.freshnessNeed, defaults.freshness),
    blocking: overrides.blocking ?? Boolean(defaults.blocking && spot.requiredByUser),
    reason: clean(overrides.reason) || `${spot.requiredByUser ? "用户必去" : "高价值候选"}${spot.name}缺少${factType}事实，可能影响路线`,
    affectedDecisions: overrides.affectedDecisions || ["spot_selected", "visit_time", "duration"],
    counterfactualUplift: overrides.counterfactualUplift ?? (spot.requiredByUser ? 1 : Math.max(0, Math.min(1, Number(spot.plannerScore || 0) / 100))),
  };
}

function currentStatus(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return clean((value as { status?: unknown }).status);
  return "";
}

export function buildResearchGapMap(profile: GapProfile, spots: GapSpot[], maxCandidates = 15) {
  const ranked = [...spots].sort((left, right) => Number(Boolean(right.requiredByUser)) - Number(Boolean(left.requiredByUser)) || Number(right.plannerScore || 0) - Number(left.plannerScore || 0));
  const required = ranked.filter((spot) => spot.requiredByUser);
  const selected = [...new Map([...required, ...ranked.slice(0, Math.max(maxCandidates, Math.min(24, spots.length)))].map((spot) => [spot.id, spot])).values()];
  const gaps: ResearchGap[] = [];
  for (const spot of selected) {
    const important = Boolean(spot.requiredByUser);
    if (!spot.openingHours || !["verified", "supported"].includes(currentStatus(spot.openingStatus))) gaps.push(gap(profile, spot, "opening_hours", { blocking: important }));
    if (important) {
      gaps.push(gap(profile, spot, "special_opening_hours", { blocking: true, reason: `${spot.name}是必去点，需要核验出行日期特殊开放安排` }));
      gaps.push(gap(profile, spot, "temporary_closure", { blocking: true }));
      if (!spot.reservation || !["verified", "not-required"].includes(clean(spot.reservation.status))) gaps.push(gap(profile, spot, "reservation", { blocking: true }));
      gaps.push(gap(profile, spot, "visit_duration"));
      gaps.push(gap(profile, spot, "internal_route"));
      gaps.push(gap(profile, spot, "local_access", { decisionImpact: 0.78, affectedDecisions: ["transit_choice", "visit_time"] }));
      if (/景区|山|湿地|古镇|乐园/.test(`${spot.name}${spot.category || ""}`)) gaps.push(gap(profile, spot, "shuttle", { affectedDecisions: ["transit_choice", "visit_time"] }));
    }
    if (important || Number(profile.budget || 0) > 0) {
      gaps.push(gap(profile, spot, "ticket_policy", {
        blocking: false,
        decisionImpact: important ? 0.82 : 0.78,
        reason: `${spot.name}的门票或免费政策会影响用户总预算，必须优先查找官方或可信公开价格`,
        affectedDecisions: ["spot_selected", "alternative_selected"],
      }));
    }
    const crowdCoverage = Number(spot.crowdRisk?.evidenceCoverage ?? spot.crowd?.evidenceCoverage ?? 0) / 100;
    if (important || /高|敏感/.test(clean(profile.crowdSensitivity)) || crowdCoverage < 0.6) {
      gaps.push(gap(profile, spot, "crowd_pattern", { uncertainty: 1 - Math.min(0.85, crowdCoverage), affectedDecisions: ["visit_time", "crowd_avoidance", "alternative_selected"] }));
      gaps.push(gap(profile, spot, "weekend_crowd", { uncertainty: 1 - Math.min(0.8, crowdCoverage) }));
      if (/^(?:\d{4}-)?(?:10-0[1-7]|05-0[1-5])/.test(profile.startDate.slice(5) ? profile.startDate.slice(5) : profile.startDate)) gaps.push(gap(profile, spot, "holiday_crowd", { uncertainty: 1 - Math.min(0.8, crowdCoverage) }));
    }
    if (/摄影/.test((profile.preferences || []).join(" "))) gaps.push(gap(profile, spot, "photography_time", { affectedDecisions: ["visit_time", "day_assignment"] }));
    if (spot.timeRole === "nightscape") gaps.push(gap(profile, spot, "night_experience", { affectedDecisions: ["visit_time"] }));
    if ((profile.seasonalNeeds || []).length) gaps.push(gap(profile, spot, "seasonal_event", { reason: `${spot.name}可能受${profile.seasonalNeeds?.join("、")}影响，需要指定日期附近证据` }));
  }
  const cityTarget: GapSpot = { id: `city:${profile.city}`, name: profile.city, requiredByUser: true, category: "目的地城市" };
  gaps.push(gap(profile, cityTarget, "transit_change", { blocking: false, reason: `${profile.city}出行期间地铁、公交或道路临时调整可能改变每日分区和出发时间`, affectedDecisions: ["transit_choice", "day_assignment", "visit_time"] }));
  gaps.push(gap(profile, cityTarget, "construction", { blocking: false, reason: `${profile.city}近期施工或封闭信息可能影响景点入口和跨区交通`, affectedDecisions: ["transit_choice", "day_assignment"] }));
  return prioritizeResearchGaps([...new Map(gaps.map((item) => [item.id, item])).values()]);
}

function querySuffix(type: ResearchQuestionType) {
  const labels: Record<ResearchQuestionType, string> = {
    opening_hours: "开放时间 官方", special_opening_hours: "指定日期 特殊开放 官方公告", temporary_closure: "最近 临时关闭 施工 官方公告",
    reservation: "预约要求 官方", ticket_policy: "门票政策 官方", entrance: "入口 游客中心 官方地图", internal_route: "内部游览路线 导览",
    visit_duration: "实际游览时长 最近游客", best_visit_time: "最佳游览时间", photography_time: "拍照 最佳光线 时间", sunset_experience: "日落 观赏时间",
    night_experience: "夜游 灯光 开放时间", seasonal_event: "近期 季节活动 官方", festival: "节庆 活动 官方", flower_season: "花期 实况 最近",
    crowd_pattern: "最近 人流 排队", queue_pattern: "入口 排队 时间", holiday_crowd: "节假日 限流 拥挤", weekend_crowd: "周末 周六 排队 人多吗",
    weather_sensitivity: "雨天 是否适合", transit_change: "公交 地铁 临时调整 官方", construction: "施工 封闭 官方公告", shuttle: "景区接驳 运营时间",
    local_access: "公共交通 到达 入口", recent_travel_feedback: "最近 游客体验",
  };
  return labels[type];
}

export function deterministicResearchRequests(profile: GapProfile, gaps: ResearchGap[], budget: AdaptiveResearchBudget): ResearchRequest[] {
  const date = clean(profile.startDate);
  const weekday = date ? new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "Asia/Shanghai" }).format(new Date(`${date}T12:00:00+08:00`)) : "";
  const requests: ResearchRequest[] = [];
  const nonBlockingTypeCounts = new Map<ResearchQuestionType, number>();
  const nonBlockingTypeLimit = Math.max(2, Math.ceil(budget.targetQueryBudget / 3));
  for (const current of prioritizeResearchGaps(gaps)) {
    if (requests.length >= budget.targetQueryBudget) break;
    if (!current.blocking && Number(nonBlockingTypeCounts.get(current.factType) || 0) >= nonBlockingTypeLimit) continue;
    const dateScope = [date, weekday].filter(Boolean).join(" ");
    const variants = [
      `${current.targetName} ${dateScope} ${querySuffix(current.factType)}`,
      current.blocking ? `${profile.city} ${current.targetName} ${querySuffix(current.factType)}` : "",
    ].filter(Boolean);
    for (const query of variants) {
      if (requests.length >= budget.targetQueryBudget) break;
      const correlation = requests.reduce((highest, request) => Math.max(highest, requestCorrelation(request, { targetId: current.targetId, questionType: current.factType, query })), 0);
      if (!current.blocking && correlation >= 0.78) continue;
      requests.push({
        queryId: `query:${current.targetId}:${current.factType}:${requests.length + 1}`,
        targetId: current.targetId,
        targetName: current.targetName,
        questionType: current.factType,
        query,
        reason: current.reason,
        expectedDecisionImpact: current.decisionImpact,
        expectedInformationGain: current.expectedInformationGain,
        estimatedCost: current.researchCost,
        preferredSourceTiers: preferredSourceTiers(current.factType),
        generatedBy: "deterministic",
      });
      if (!current.blocking) nonBlockingTypeCounts.set(current.factType, Number(nonBlockingTypeCounts.get(current.factType) || 0) + 1);
      if (!current.blocking) break;
    }
  }
  return dedupeRequests(requests);
}

export function requestCorrelation(left: Pick<ResearchRequest, "targetId" | "questionType" | "query">, right: Pick<ResearchRequest, "targetId" | "questionType" | "query">) {
  const tokens = (query: string) => new Set(clean(query).toLowerCase().split(/[\s，。；、:：/]+/).filter((token) => token.length > 1));
  const a = tokens(left.query);
  const b = tokens(right.query);
  const lexical = [...a].filter((token) => b.has(token)).length / Math.max(1, new Set([...a, ...b]).size);
  const target = left.targetId === right.targetId ? 0.35 : 0;
  const type = left.questionType === right.questionType ? 0.35 : 0;
  return Math.min(1, lexical * 0.3 + target + type);
}

export function normalizeAiResearchRequests(value: unknown, profile: GapProfile, gaps: ResearchGap[], budget: AdaptiveResearchBudget) {
  const rows = Array.isArray(value) ? value : Array.isArray((value as { requests?: unknown[] })?.requests) ? (value as { requests: unknown[] }).requests : [];
  const gapMap = new Map(gaps.map((item) => [`${item.targetId}:${item.factType}`, item]));
  const normalized: ResearchRequest[] = [];
  for (const [index, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const targetId = clean(item.targetId);
    const questionType = clean(item.questionType) as ResearchQuestionType;
    const related = gapMap.get(`${targetId}:${questionType}`);
    const query = clean(item.query).slice(0, 120);
    if (!related || query.length < 4 || !query.includes(related.targetName)) continue;
    normalized.push({
      queryId: clean(item.queryId) || `ai-query:${targetId}:${questionType}:${index + 1}`,
      targetId,
      targetName: related.targetName,
      questionType,
      query,
      reason: clean(item.reason) || related.reason,
      expectedDecisionImpact: clamp01(item.expectedDecisionImpact, related.decisionImpact),
      expectedInformationGain: clamp01(item.expectedInformationGain, related.expectedInformationGain),
      estimatedCost: Math.max(0.15, Number(item.estimatedCost || related.researchCost)),
      preferredSourceTiers: preferredSourceTiers(questionType),
      generatedBy: "ai",
    });
    if (normalized.length >= budget.targetQueryBudget) break;
  }
  const deterministic = deterministicResearchRequests(profile, gaps, budget);
  if (!normalized.length) return deterministic;
  const ticketReservation = Number(profile.budget || 0) > 0
    ? dedupeRequests([
        ...normalized.filter((request) => request.questionType === "ticket_policy"),
        ...deterministic.filter((request) => request.questionType === "ticket_policy"),
      ]).slice(0, Math.max(1, Math.ceil(budget.targetQueryBudget / 3)))
    : [];
  const aiWithReservation = ticketReservation.length
    ? [...normalized.filter((request) => request.questionType !== "ticket_policy").slice(0, Math.max(0, budget.targetQueryBudget - ticketReservation.length)), ...ticketReservation]
    : normalized;
  return dedupeRequests([...aiWithReservation, ...deterministic]).slice(0, budget.targetQueryBudget);
}

function dedupeRequests(requests: ResearchRequest[]) {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = `${request.targetId}|${request.questionType}|${request.query.toLowerCase().replace(/\s+/g, "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applyFactsToGaps(gaps: ResearchGap[], facts: SynthesizedFact[]) {
  const factMap = new Map(facts.map((fact) => [`${fact.targetId}:${fact.factType}`, fact]));
  return gaps.map((item) => {
    const fact = factMap.get(`${item.targetId}:${item.factType}`);
    if (!fact) return item;
    return { ...item, currentStatus: fact.status, uncertainty: fact.status === "verified" ? 0.05 : fact.status === "supported" ? 0.25 : fact.status === "conflicting" ? 0.9 : item.uncertainty };
  });
}

export function skippedResearchItems(gaps: ResearchGap[], requests: ResearchRequest[], budgetExhausted = false): SkippedResearchItem[] {
  const requested = new Set(requests.map((request) => `${request.targetId}:${request.questionType}`));
  return gaps.filter((gap) => !requested.has(`${gap.targetId}:${gap.factType}`)).map((gap) => ({ targetId: gap.targetId, factType: gap.factType, reason: budgetExhausted ? "budget_exhausted" : researchUtility(gap) < 0.08 ? "low_decision_impact" : "already_resolved" }));
}
