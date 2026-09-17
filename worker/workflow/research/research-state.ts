import type { AdaptiveResearchBudget } from "../../domain/research-budget.ts";
import type { ResearchGap } from "../../domain/research-types.ts";

export type PlannerResearchCursor =
  | { step: "plan_queries" }
  | { step: "search_batch"; batch: number }
  | { step: "fetch_batch"; batch: number }
  | { step: "extract_batch"; batch: number }
  | { step: "refine_batch"; batch: number }
  | { step: "fuse" }
  | { step: "finalize" }
  | { step: "done" };

export interface PlannerResearchState {
  version: 30;
  round: number;
  maxRounds: number;
  cursor: PlannerResearchCursor;
  gaps: ResearchGap[];
  budget: AdaptiveResearchBudget;
  pendingQueryIds: string[];
  completedQueryIds: string[];
  queryArtifactKeys: string[];
  searchOperationIds: string[];
  fetchOperationIds: string[];
  extractOperationIds: string[];
  refineOperationIds: string[];
  factsArtifactKey?: string;
  informationGains: number[];
  aiCallCount: number;
  model: string | null;
  modelStatus: "ready" | "degraded" | "unavailable";
  degradedReasons: string[];
  remainingBudget: number;
  retryCounters: Record<string, number>;
  retryNotBefore?: number;
  stopReason?: string;
  startedAt: string;
  updatedAt: string;
}

export function createPlannerResearchState(input: {
  gaps: ResearchGap[];
  budget: AdaptiveResearchBudget;
  maxRounds: number;
  now?: string;
}): PlannerResearchState {
  const now = input.now ?? new Date().toISOString();
  return {
    version: 30,
    round: 0,
    maxRounds: input.maxRounds,
    cursor: { step: "plan_queries" },
    gaps: input.gaps,
    budget: input.budget,
    pendingQueryIds: [],
    completedQueryIds: [],
    queryArtifactKeys: [],
    searchOperationIds: [],
    fetchOperationIds: [],
    extractOperationIds: [],
    refineOperationIds: [],
    informationGains: [],
    aiCallCount: 0,
    model: null,
    modelStatus: "unavailable",
    degradedReasons: [],
    remainingBudget: input.budget.remainingCostUnits,
    retryCounters: {},
    startedAt: now,
    updatedAt: now,
  };
}

export function researchMicroStepLabel(state: PlannerResearchState): string {
  const suffix = "batch" in state.cursor ? `:${state.cursor.batch}` : "";
  return `planner_research:round:${state.round}:${state.cursor.step}${suffix}`;
}
