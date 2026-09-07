import type { PageAccessStatus, ResearchQuestionType, SourceTier } from "./research-types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const FACT_POLICY_VERSION = "fact-policy-2026-09";

export interface FactFreshnessPolicy {
  sourceMaxAgeMs: number | null;
  searchCacheTtlMs: number;
  pageCacheTtlMs: number;
  factCacheTtlMs: number;
  dynamic: boolean;
  expiresAfterTargetDate?: boolean;
}

const STATIC: FactFreshnessPolicy = { sourceMaxAgeMs: 2 * 365 * DAY, searchCacheTtlMs: 30 * DAY, pageCacheTtlMs: 30 * DAY, factCacheTtlMs: 90 * DAY, dynamic: false };
const SEMI: FactFreshnessPolicy = { sourceMaxAgeMs: 180 * DAY, searchCacheTtlMs: DAY, pageCacheTtlMs: 3 * DAY, factCacheTtlMs: 7 * DAY, dynamic: true };
const SHORT: FactFreshnessPolicy = { sourceMaxAgeMs: 30 * DAY, searchCacheTtlMs: HOUR, pageCacheTtlMs: 3 * HOUR, factCacheTtlMs: 6 * HOUR, dynamic: true };

export const FACT_FRESHNESS_POLICIES: Record<ResearchQuestionType, FactFreshnessPolicy> = {
  opening_hours: SEMI,
  special_opening_hours: { sourceMaxAgeMs: 90 * DAY, searchCacheTtlMs: 3 * HOUR, pageCacheTtlMs: 6 * HOUR, factCacheTtlMs: 6 * HOUR, dynamic: true, expiresAfterTargetDate: true },
  temporary_closure: { sourceMaxAgeMs: 30 * DAY, searchCacheTtlMs: 30 * 60 * 1000, pageCacheTtlMs: HOUR, factCacheTtlMs: 2 * HOUR, dynamic: true, expiresAfterTargetDate: true },
  reservation: { ...SEMI, sourceMaxAgeMs: 90 * DAY, factCacheTtlMs: 3 * DAY },
  ticket_policy: { ...SEMI, sourceMaxAgeMs: 90 * DAY, factCacheTtlMs: 3 * DAY },
  entrance: STATIC,
  internal_route: { ...STATIC, searchCacheTtlMs: 7 * DAY, factCacheTtlMs: 30 * DAY },
  visit_duration: { ...STATIC, sourceMaxAgeMs: 365 * DAY, factCacheTtlMs: 30 * DAY },
  best_visit_time: { ...STATIC, sourceMaxAgeMs: 365 * DAY, factCacheTtlMs: 30 * DAY },
  photography_time: { ...STATIC, sourceMaxAgeMs: 365 * DAY, factCacheTtlMs: 30 * DAY },
  sunset_experience: SHORT,
  night_experience: SHORT,
  seasonal_event: { ...SHORT, searchCacheTtlMs: 3 * HOUR, factCacheTtlMs: 12 * HOUR, expiresAfterTargetDate: true },
  festival: { ...SHORT, searchCacheTtlMs: 3 * HOUR, factCacheTtlMs: 12 * HOUR, expiresAfterTargetDate: true },
  flower_season: { sourceMaxAgeMs: 7 * DAY, searchCacheTtlMs: 3 * HOUR, pageCacheTtlMs: 6 * HOUR, factCacheTtlMs: DAY, dynamic: true },
  crowd_pattern: { ...SHORT, sourceMaxAgeMs: 30 * DAY, factCacheTtlMs: 6 * HOUR },
  queue_pattern: { ...SHORT, sourceMaxAgeMs: 30 * DAY, factCacheTtlMs: 6 * HOUR },
  holiday_crowd: { ...SHORT, sourceMaxAgeMs: 365 * DAY, factCacheTtlMs: DAY },
  weekend_crowd: { ...SHORT, sourceMaxAgeMs: 90 * DAY, factCacheTtlMs: 6 * HOUR },
  weather_sensitivity: STATIC,
  transit_change: { ...SHORT, sourceMaxAgeMs: 14 * DAY, factCacheTtlMs: 6 * HOUR, expiresAfterTargetDate: true },
  construction: { ...SHORT, sourceMaxAgeMs: 30 * DAY, factCacheTtlMs: 6 * HOUR, expiresAfterTargetDate: true },
  shuttle: { ...SEMI, factCacheTtlMs: 3 * DAY },
  local_access: { ...SEMI, factCacheTtlMs: 3 * DAY },
  recent_travel_feedback: { ...SHORT, sourceMaxAgeMs: 30 * DAY, factCacheTtlMs: 6 * HOUR },
};

const OFFICIAL_FIRST = new Set<ResearchQuestionType>(["opening_hours", "special_opening_hours", "temporary_closure", "reservation", "ticket_policy", "transit_change", "construction", "shuttle"]);
const UGC_FRIENDLY = new Set<ResearchQuestionType>(["visit_duration", "best_visit_time", "photography_time", "crowd_pattern", "queue_pattern", "weekend_crowd", "recent_travel_feedback", "internal_route", "entrance"]);

export function preferredSourceTiers(questionType: ResearchQuestionType): SourceTier[] {
  if (OFFICIAL_FIRST.has(questionType)) return ["tier_1_official", "tier_2_professional", "tier_3_news", "tier_4_ugc"];
  if (UGC_FRIENDLY.has(questionType)) return ["tier_4_ugc", "tier_2_professional", "tier_1_official", "tier_3_news"];
  return ["tier_1_official", "tier_3_news", "tier_2_professional", "tier_4_ugc"];
}

export function sourceFitFor(questionType: ResearchQuestionType, tier: SourceTier) {
  const order = preferredSourceTiers(questionType);
  const index = order.indexOf(tier);
  return index < 0 ? 0.25 : [1, 0.82, 0.62, 0.45][index];
}

export function pageStatusEvidenceCeiling(status: PageAccessStatus, critical: boolean) {
  if (status === "page_fetched") return critical ? "verified" : "supported";
  if (status === "snippet_only") return "weak";
  return "reject";
}

export function sourceFreshness(questionType: ResearchQuestionType, publishedAt: string | undefined, now = Date.now()) {
  const policy = FACT_FRESHNESS_POLICIES[questionType];
  if (!publishedAt || policy.sourceMaxAgeMs == null) return policy.dynamic ? 0.35 : 0.65;
  const age = Math.max(0, now - Date.parse(publishedAt));
  if (!Number.isFinite(age)) return policy.dynamic ? 0.3 : 0.6;
  if (age > policy.sourceMaxAgeMs) return 0;
  return Number(Math.max(0.15, 1 - age / policy.sourceMaxAgeMs).toFixed(3));
}

export function isCriticalFact(questionType: ResearchQuestionType) {
  return OFFICIAL_FIRST.has(questionType) || questionType === "entrance";
}
