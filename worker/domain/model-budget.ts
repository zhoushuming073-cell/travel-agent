import type { AiPurpose } from "./model-routing.ts";

export interface ModelTokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCallsPerStage: number;
}

const BUDGETS: Record<AiPurpose, ModelTokenBudget> = {
  extract: { maxInputTokens: 8_000, maxOutputTokens: 3_200, maxCallsPerStage: 2 },
  research: { maxInputTokens: 18_000, maxOutputTokens: 3_200, maxCallsPerStage: 3 },
  planner: { maxInputTokens: 28_000, maxOutputTokens: 5_400, maxCallsPerStage: 2 },
  critic: { maxInputTokens: 20_000, maxOutputTokens: 2_400, maxCallsPerStage: 1 },
  repair: { maxInputTokens: 20_000, maxOutputTokens: 5_600, maxCallsPerStage: 2 },
  explain: { maxInputTokens: 14_000, maxOutputTokens: 2_400, maxCallsPerStage: 2 },
  enrich: { maxInputTokens: 12_000, maxOutputTokens: 3_200, maxCallsPerStage: 2 },
};

export const modelTokenBudget = (purpose: AiPurpose) => BUDGETS[purpose];
export const approximateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 3.2);

export function enforceOutputTokenBudget(purpose: AiPurpose, requested = 0) {
  const budget = modelTokenBudget(purpose);
  return Math.max(256, Math.min(budget.maxOutputTokens, requested || budget.maxOutputTokens));
}
