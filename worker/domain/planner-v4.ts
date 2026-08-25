export type MatrixQuality = "routed" | "estimated";

export interface TrafficMatrixLeg {
  fromId: string;
  toId: string;
  durationMin: number;
  distanceM: number;
  source: string;
  quality: MatrixQuality;
  fetchedAt: string;
}

export interface TrafficMatrix {
  source: string;
  fetchedAt: string;
  quality: MatrixQuality;
  nodes: Array<{ id: string; name: string; lat?: number; lng?: number }>;
  legs: TrafficMatrixLeg[];
}

export interface PlannerSpot {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
  requiredByUser?: boolean;
  tags?: string[];
  category?: string;
  openingHours?: string | null;
  openingStatus?: "verified" | "estimated" | "unknown" | "conflicting";
  openingAlert?: string | null;
  reservation?: { status: "verified" | "predicted" | "unknown"; note?: string };
  indoor?: boolean | null;
  recommendedDurationMin?: number;
  bestTimes?: string[];
  seasonFit?: { status: "verified" | "predicted" | "unknown"; note?: string; source?: string };
  hotness?: { score?: number | null; label?: string; confidence?: number };
  crowdRisk?: { score?: number | null; label?: string; confidence?: number; uncertainty?: string };
  sources?: Array<{ name: string; url?: string | null; fetchedAt?: string; status?: string }>;
  [key: string]: unknown;
}

export interface PlannerKnowledgePack {
  profile: Record<string, unknown> & {
    city?: string;
    days?: number;
    dayStart?: string;
    dayEnd?: string;
    requiredAttractions?: string[];
  };
  spots: PlannerSpot[];
  weather: unknown[];
  hotel: unknown;
  trafficMatrix?: TrafficMatrix;
  unknowns: string[];
  webResearch?: unknown[];
}

export interface PlannerActivity {
  type: "attraction" | "meal" | "rest";
  spotId?: string;
  label?: string;
  startTime: string;
  endTime: string;
  durationMin: number;
  transportFromPrevious?: {
    mode: string;
    durationMin: number;
    matrixKey?: string;
  };
  reason: string;
  evidenceRefs: string[];
  alternativeSpotIds?: string[];
  adjustmentCondition?: string;
}

export interface PlannerDayDraft {
  day: number;
  theme: string;
  activities: PlannerActivity[];
  returnHotelTime: string;
  totalActivityMin: number;
  totalTransportMin: number;
}

export interface PlannerVariantDraft {
  id: string;
  title: string;
  style: string;
  strategy: string;
  days: PlannerDayDraft[];
}

export interface PlannerDraft {
  variants: PlannerVariantDraft[];
  degraded?: boolean;
  degradationReason?: string;
}

export interface DraftIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  variantId?: string;
  day?: number;
  spotId?: string;
}

function timeToMinutes(value: unknown): number | null {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

function openingRange(value: unknown): [number, number] | null {
  const matches = String(value ?? "").match(/(\d{1,2}):(\d{2})\s*[-—至]\s*(\d{1,2}):(\d{2})/);
  if (!matches) return null;
  return [Number(matches[1]) * 60 + Number(matches[2]), Number(matches[3]) * 60 + Number(matches[4])];
}

export function parseStrictJsonObject(text: string): Record<string, unknown> {
  const stripped = String(text ?? "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const value = JSON.parse(stripped);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value;
  } catch {
    throw new Error("DeepSeek 未返回有效 JSON 对象");
  }
}

export function mergeDeterministicProfile(
  deterministic: Record<string, unknown>,
  extracted: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...extracted, ...deterministic };
  const hardRequired = Array.isArray(deterministic.requiredAttractions)
    ? deterministic.requiredAttractions.map(String).filter(Boolean)
    : [];
  merged.requiredAttractions = hardRequired.length
    ? [...new Set(hardRequired)]
    : [...new Set((Array.isArray(extracted.requiredAttractions) ? extracted.requiredAttractions : []).map(String).filter(Boolean))];
  return merged;
}

export function sanitizeHotelPrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const match = String(value ?? "").replace(/,/g, "").match(/(?:¥|￥)?\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
}

export async function settleTravelProviders(
  providers: Record<string, Promise<unknown>>,
): Promise<Record<string, { status: "ready" | "unavailable"; data?: unknown; error?: string }>> {
  const entries = Object.entries(providers);
  const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
  return Object.fromEntries(settled.map((result, index) => {
    const key = entries[index][0];
    return result.status === "fulfilled"
      ? [key, { status: "ready" as const, data: result.value }]
      : [key, { status: "unavailable" as const, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }];
  }));
}

export function assertPlannerContext(pack: PlannerKnowledgePack): void {
  if (!pack.trafficMatrix?.legs?.length || !pack.trafficMatrix.fetchedAt || !pack.trafficMatrix.source) {
    throw new Error("核心规划调用前必须先生成带来源和更新时间的交通矩阵");
  }
  if (!pack.spots.length) throw new Error("核心规划调用前候选景点知识包不能为空");
}

function spotSet(variant: PlannerVariantDraft): Set<string> {
  return new Set(variant.days.flatMap((day) => day.activities.map((activity) => activity.spotId).filter((id): id is string => Boolean(id))));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 1;
}

export function buildDifferenceMetrics(draft: PlannerDraft) {
  const pairs: Array<{ left: string; right: string; jaccard: number; orderDifference: number; dailyCountDifference: number }> = [];
  for (let leftIndex = 0; leftIndex < draft.variants.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < draft.variants.length; rightIndex += 1) {
      const left = draft.variants[leftIndex];
      const right = draft.variants[rightIndex];
      const leftOrder = left.days.flatMap((day) => day.activities.map((item) => item.spotId).filter(Boolean));
      const rightOrder = right.days.flatMap((day) => day.activities.map((item) => item.spotId).filter(Boolean));
      const length = Math.max(leftOrder.length, rightOrder.length, 1);
      const orderDifference = Array.from({ length }, (_, index) => leftOrder[index] === rightOrder[index] ? 0 : 1).reduce<number>((sum, value) => sum + value, 0) / length;
      const dailyCountDifference = left.days.reduce((sum, day, index) => {
        const leftCount = day.activities.filter((item) => item.type === "attraction").length;
        const rightCount = right.days[index]?.activities.filter((item) => item.type === "attraction").length ?? 0;
        return sum + Math.abs(leftCount - rightCount);
      }, 0);
      pairs.push({ left: left.id, right: right.id, jaccard: jaccard(spotSet(left), spotSet(right)), orderDifference, dailyCountDifference });
    }
  }
  return {
    pairs,
    maxJaccard: pairs.length ? Math.max(...pairs.map((pair) => pair.jaccard)) : 1,
    minOrderDifference: pairs.length ? Math.min(...pairs.map((pair) => pair.orderDifference)) : 0,
  };
}

export function auditPlannerDraft(draft: PlannerDraft, pack: PlannerKnowledgePack) {
  const issues: DraftIssue[] = [];
  const profile = pack.profile;
  const expectedDays = Number(profile.days ?? 0);
  const startLimit = timeToMinutes(profile.dayStart ?? "09:00") ?? 540;
  const endLimit = timeToMinutes(profile.dayEnd ?? "21:00") ?? 1260;
  const spotMap = new Map(pack.spots.map((spot) => [spot.id, spot]));
  const requiredSpots = pack.spots.filter((spot) => spot.requiredByUser);

  if (draft.variants.length !== 3) {
    issues.push({ code: "VARIANT_COUNT", severity: "error", message: "必须返回正好三套方案" });
  }
  for (const variant of draft.variants) {
    if (variant.days.length !== expectedDays) issues.push({ code: "DAY_COUNT", severity: "error", variantId: variant.id, message: `${variant.title} 天数与用户需求不一致` });
    const used = new Set<string>();
    const allIds = variant.days.flatMap((day) => day.activities.map((activity) => activity.spotId).filter((id): id is string => Boolean(id)));
    for (const required of requiredSpots) {
      if (!allIds.includes(required.id)) issues.push({ code: "REQUIRED_MISSING", severity: "error", variantId: variant.id, spotId: required.id, message: `${variant.title} 缺少必去景点 ${required.name}` });
    }
    for (const day of variant.days) {
      const attractionActivities = day.activities.filter((activity) => activity.type === "attraction");
      const meals = day.activities.filter((activity) => activity.type === "meal");
      const rests = day.activities.filter((activity) => activity.type === "rest");
      if (!meals.length) issues.push({ code: "MEAL_MISSING", severity: "error", variantId: variant.id, day: day.day, message: `${variant.title} 第 ${day.day} 天缺少正常用餐` });
      if (!rests.length) issues.push({ code: "REST_MISSING", severity: "warning", variantId: variant.id, day: day.day, message: `${variant.title} 第 ${day.day} 天缺少弹性休息` });
      for (const activity of attractionActivities) {
        const start = timeToMinutes(activity.startTime);
        const end = timeToMinutes(activity.endTime);
        if (!activity.spotId || !spotMap.has(activity.spotId)) {
          issues.push({ code: "UNKNOWN_SPOT", severity: "error", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${variant.title} 使用了候选池外景点` });
          continue;
        }
        if (used.has(activity.spotId)) issues.push({ code: "DUPLICATE_SPOT", severity: "warning", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${variant.title} 重复安排 ${spotMap.get(activity.spotId)?.name}` });
        used.add(activity.spotId);
        if (start === null || end === null || start < startLimit || end > endLimit || end <= start) {
          issues.push({ code: "TIME_RANGE", severity: "error", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${variant.title} 第 ${day.day} 天活动超出用户每日时段` });
        }
        const open = openingRange(spotMap.get(activity.spotId)?.openingHours);
        if (open && start !== null && end !== null && (start < open[0] || end > open[1])) {
          issues.push({ code: "OPENING_CONFLICT", severity: "error", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${spotMap.get(activity.spotId)?.name} 与开放时间冲突` });
        }
        const openingAlert = spotMap.get(activity.spotId)?.openingAlert;
        if (openingAlert) {
          issues.push({ code: "OPENING_ALERT_REVIEW", severity: "warning", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${spotMap.get(activity.spotId)?.name} 存在近期开放状态公告，需核对公告日期：${openingAlert}` });
        }
        const previousAttraction = attractionActivities[attractionActivities.indexOf(activity) - 1];
        if (previousAttraction?.spotId && activity.transportFromPrevious && pack.trafficMatrix) {
          const matrixLeg = pack.trafficMatrix.legs.find((leg) => leg.fromId === previousAttraction.spotId && leg.toId === activity.spotId)
            ?? pack.trafficMatrix.legs.find((leg) => leg.fromId === activity.spotId && leg.toId === previousAttraction.spotId);
          if (!matrixLeg) {
            issues.push({ code: "MATRIX_LEG_MISSING", severity: "error", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${variant.title} 的相邻景点不在交通矩阵中` });
          } else if (Math.abs(Number(activity.transportFromPrevious.durationMin) - matrixLeg.durationMin) > Math.max(12, matrixLeg.durationMin * 0.45)) {
            issues.push({ code: "TRANSIT_MISMATCH", severity: "warning", variantId: variant.id, day: day.day, spotId: activity.spotId, message: `${variant.title} 的交通时间与输入矩阵差异过大` });
          }
        }
      }
      const returnTime = timeToMinutes(day.returnHotelTime);
      if (returnTime === null || returnTime > endLimit) issues.push({ code: "RETURN_TOO_LATE", severity: "error", variantId: variant.id, day: day.day, message: `${variant.title} 第 ${day.day} 天返回住宿地时间过晚` });
    }
  }

  const differences = buildDifferenceMetrics(draft);
  if (draft.variants.length === 3 && (differences.maxJaccard > 0.9 && differences.minOrderDifference < 0.35)) {
    issues.push({ code: "VARIANTS_TOO_SIMILAR", severity: "error", message: "三套方案的景点集合和顺序差异不足" });
  }
  const hardIssues = issues.filter((issue) => issue.severity === "error");
  return { issues, hardIssues, needsRepair: issues.length > 0, differences };
}

export function preserveLockedDays(
  previous: PlannerVariantDraft,
  proposed: PlannerVariantDraft,
  affectedDays: number[],
): PlannerVariantDraft {
  const affected = new Set(affectedDays);
  const previousByDay = new Map(previous.days.map((day) => [day.day, day]));
  return {
    ...proposed,
    days: proposed.days.map((day) => affected.has(day.day) ? day : structuredClone(previousByDay.get(day.day) ?? day)),
  };
}
