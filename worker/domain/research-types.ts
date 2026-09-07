export type ResearchQuestionType =
  | "opening_hours"
  | "special_opening_hours"
  | "temporary_closure"
  | "reservation"
  | "ticket_policy"
  | "entrance"
  | "internal_route"
  | "visit_duration"
  | "best_visit_time"
  | "photography_time"
  | "sunset_experience"
  | "night_experience"
  | "seasonal_event"
  | "festival"
  | "flower_season"
  | "crowd_pattern"
  | "queue_pattern"
  | "holiday_crowd"
  | "weekend_crowd"
  | "weather_sensitivity"
  | "transit_change"
  | "construction"
  | "shuttle"
  | "local_access"
  | "recent_travel_feedback";

export type DataOrigin =
  | "official_api"
  | "third_party_api"
  | "official_web"
  | "professional_web"
  | "news"
  | "ugc"
  | "ai_inference"
  | "deterministic_estimate"
  | "user_input"
  | "unknown";

export type SourceTier = "tier_1_official" | "tier_2_professional" | "tier_3_news" | "tier_4_ugc" | "unknown";

export type PageAccessStatus =
  | "search_discovered"
  | "page_fetched"
  | "snippet_only"
  | "blocked_robots"
  | "blocked_auth"
  | "captcha"
  | "paywalled"
  | "expired"
  | "deleted"
  | "parse_failed"
  | "network_failed";

export type SynthesizedFactStatus = "verified" | "supported" | "estimated" | "inferred" | "unknown" | "conflicting";

export interface Provenanced<T> {
  value: T | null;
  origin: DataOrigin;
  confidence: number;
  fetchedAt?: string;
  validFrom?: string;
  validTo?: string;
  evidenceIds: string[];
}

export interface ResearchGap {
  id: string;
  targetId: string;
  targetName: string;
  factType: ResearchQuestionType;
  currentStatus: SynthesizedFactStatus;
  decisionImpact: number;
  uncertainty: number;
  expectedInformationGain: number;
  researchCost: number;
  freshnessNeed: number;
  blocking: boolean;
  reason: string;
  affectedDecisions: string[];
  /** Expected objective uplift if this unknown fact becomes decision-changing. */
  counterfactualUplift?: number;
}

export interface ResearchRequest {
  queryId: string;
  targetId: string;
  targetName: string;
  questionType: ResearchQuestionType;
  query: string;
  reason: string;
  expectedDecisionImpact: number;
  expectedInformationGain: number;
  estimatedCost: number;
  preferredSourceTiers: SourceTier[];
  generatedBy: "ai" | "deterministic";
  executedAt?: string;
}

export interface SearchResultCandidate {
  id: string;
  queryId: string;
  title: string;
  url: string | null;
  snippet: string;
  provider: string;
  sourceTier: SourceTier;
  discoveredAt: string;
  publishedAt?: string;
  pageStatus: PageAccessStatus;
  targetId: string;
  questionType: ResearchQuestionType;
}

export interface ResearchEvidence {
  id: string;
  queryId: string;
  targetId: string;
  targetName: string;
  questionType: ResearchQuestionType;
  extractedValue: unknown;
  passage: string;
  title: string;
  url: string | null;
  publisher: string;
  sourceTier: SourceTier;
  origin: DataOrigin;
  pageStatus: PageAccessStatus;
  publishedAt?: string;
  fetchedAt: string;
  validFrom?: string;
  validTo?: string;
  authority: number;
  relevance: number;
  sourceFit: number;
  freshness: number;
  specificity: number;
  entityMatchConfidence: number;
  commercialBias: number;
  seoRisk: number;
  independenceGroupId: string;
  contentHash: string;
  disposition: "accept" | "weak" | "reject";
  rejectionReasons: string[];
}

export interface SynthesizedFact<T = unknown> {
  id: string;
  targetId: string;
  targetName: string;
  factType: ResearchQuestionType;
  value: T | null;
  conservativeValue?: T | null;
  status: SynthesizedFactStatus;
  confidence: number;
  supportingEvidenceIds: string[];
  conflictingEvidenceIds: string[];
  reasoningSummary?: string;
  fetchedAt: string;
  validFrom?: string;
  validTo?: string;
}

export interface ResearchMetrics {
  rawResultCount: number;
  fetchedPageCount: number;
  acceptedEvidenceCount: number;
  independentEvidenceCount: number;
  evidenceDedupRatio: number;
  sourceTierDistribution: Record<SourceTier, number>;
  freshnessCoverage: number;
  decisionImpactCoverage: number;
  searchCount: number;
  pageReadCount: number;
  aiCallCount: number;
  realizedInformationGain: number;
}

export interface DecisionTrace {
  decisionId: string;
  decisionType: "spot_selected" | "spot_excluded" | "visit_time" | "duration" | "day_assignment" | "alternative_selected" | "crowd_avoidance" | "transit_choice";
  variantId?: string;
  day?: number;
  targetIds: string[];
  userPreferenceIds: string[];
  factIds: string[];
  evidenceIds: string[];
  algorithmConstraintIds: string[];
  resultingDecision: string;
  counterfactual?: string;
}

export interface SkippedResearchItem {
  targetId: string;
  factType: ResearchQuestionType;
  reason: "low_decision_impact" | "already_resolved" | "budget_exhausted" | "provider_unavailable";
}

export type PlanningMode = "ai_optimized" | "ai_assisted" | "deterministic_recovery";
