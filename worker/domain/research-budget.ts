import type { ResearchGap } from "./research-types.ts";

const bounded = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

export interface ResearchComplexity {
  tripDays: number;
  cityCount: number;
  requiredSpotCount: number;
  blockingUnknownCount: number;
  highRiskFactCount: number;
  candidateCount: number;
  dynamicEventCount?: number;
  crossCityLegCount?: number;
  deepResearch?: boolean;
}

export interface AdaptiveResearchBudget {
  baseBudget: number;
  complexityScore: number;
  researchUncertaintyScore: number;
  targetQueryBudget: number;
  targetPageBudget: number;
  aiCallBudget: number;
  hardCap: number;
  remainingCostUnits: number;
  extensionEligible: boolean;
  stopReason?: "blocking_resolved" | "low_information_gain" | "stalled" | "budget_exhausted" | "hard_cap";
}

export function researchComplexityScore(input: ResearchComplexity) {
  return Math.max(0,
    0.15 * Math.max(1, input.tripDays) +
    0.75 * Math.max(0, input.cityCount - 1) +
    0.35 * Math.max(0, input.requiredSpotCount) +
    0.25 * Math.max(0, input.blockingUnknownCount) +
    0.20 * Math.max(0, input.highRiskFactCount) +
    0.03 * Math.max(0, input.candidateCount) +
    0.30 * Math.max(0, input.dynamicEventCount || 0) +
    0.40 * Math.max(0, input.crossCityLegCount || 0));
}

export function createAdaptiveResearchBudget(input: ResearchComplexity): AdaptiveResearchBudget {
  const complexityScore = researchComplexityScore(input);
  const researchUncertaintyScore = Math.max(0,
    0.55 * input.blockingUnknownCount +
    0.35 * input.highRiskFactCount +
    0.25 * (input.dynamicEventCount || 0) +
    0.08 * input.requiredSpotCount +
    0.02 * input.candidateCount);
  const hardCap = input.deepResearch ? 56 : 32;
  const rawQueryTarget = Math.ceil((4 + 1.75 * researchUncertaintyScore) * (input.deepResearch ? 1.5 : 1));
  const targetQueryBudget = Math.max(3, Math.min(hardCap, rawQueryTarget));
  const targetPageBudget = Math.min(hardCap + 8, Math.ceil(targetQueryBudget * 1.25));
  const aiCallBudget = Math.max(3, Math.min(input.deepResearch ? 12 : 8, 3 + Math.ceil(complexityScore / 3)));
  return {
    baseBudget: input.deepResearch ? 15 : 8,
    complexityScore: Number(complexityScore.toFixed(2)),
    researchUncertaintyScore: Number(researchUncertaintyScore.toFixed(2)),
    targetQueryBudget,
    targetPageBudget,
    aiCallBudget,
    hardCap,
    remainingCostUnits: targetQueryBudget + Math.ceil(targetPageBudget * 0.5) + aiCallBudget * 1.5,
    extensionEligible: targetQueryBudget < hardCap,
  };
}

export function researchUtility(gap: ResearchGap) {
  const decisionChangeProbability = bounded(gap.uncertainty) * bounded(gap.expectedInformationGain);
  const counterfactualMultiplier = 1 + bounded(gap.counterfactualUplift || 0) * 0.5;
  const valueOfInformation = decisionChangeProbability * bounded(gap.decisionImpact) * bounded(gap.freshnessNeed, 0.25, 1) * counterfactualMultiplier;
  return Number((valueOfInformation / Math.max(0.15, gap.researchCost)).toFixed(4));
}

export function counterfactualResearchValue(gap: ResearchGap, baselineObjective: number, verifiedObjective: number) {
  const uplift = Math.max(0, verifiedObjective - baselineObjective) / Math.max(1, Math.abs(baselineObjective));
  return researchUtility({ ...gap, counterfactualUplift: bounded(uplift) });
}

export function prioritizeResearchGaps(gaps: ResearchGap[]) {
  return [...gaps].sort((left, right) => {
    if (left.blocking !== right.blocking) return left.blocking ? -1 : 1;
    return researchUtility(right) - researchUtility(left);
  });
}

export function shouldContinueResearch(input: {
  gaps: ResearchGap[];
  budget: AdaptiveResearchBudget;
  recentInformationGains: number[];
  queriesExecuted: number;
  minimumUtility?: number;
}) {
  const active = prioritizeResearchGaps(input.gaps.filter((gap) => gap.currentStatus === "unknown" || gap.currentStatus === "conflicting"));
  const blocking = active.filter((gap) => gap.blocking);
  if (!active.length) return { continue: false, reason: "blocking_resolved" as const };
  if (input.queriesExecuted >= input.budget.hardCap) return { continue: false, reason: "hard_cap" as const };
  if (input.budget.remainingCostUnits <= 0) return { continue: false, reason: "budget_exhausted" as const };
  const recent = input.recentInformationGains.slice(-2);
  if (!blocking.length && recent.length >= 1 && recent.at(-1)! < 0.04 && researchUtility(active[0]) < 0.2) return { continue: false, reason: "low_information_gain" as const };
  if (recent.length === 2 && recent.every((gain) => gain < 0.04)) return { continue: false, reason: "stalled" as const };
  const utility = researchUtility(active[0]);
  if (!blocking.length && utility < (input.minimumUtility ?? 0.08)) return { continue: false, reason: "low_information_gain" as const };
  return { continue: true, reason: null, nextGap: active[0], utility };
}

export function spendResearchBudget(budget: AdaptiveResearchBudget, costUnits: number) {
  return { ...budget, remainingCostUnits: Math.max(0, Number((budget.remainingCostUnits - Math.max(0, costUnits)).toFixed(2))) };
}

export function extendResearchBudget(budget: AdaptiveResearchBudget, unresolvedBlocking: number, realizedInformationGain: number) {
  if (!budget.extensionEligible || unresolvedBlocking <= 0 || realizedInformationGain < 0.12) return budget;
  const extension = Math.min(6, Math.max(2, unresolvedBlocking));
  const targetQueryBudget = Math.min(budget.hardCap, budget.targetQueryBudget + extension);
  return { ...budget, targetQueryBudget, targetPageBudget: Math.min(budget.hardCap + 8, budget.targetPageBudget + extension), remainingCostUnits: budget.remainingCostUnits + extension * 1.5, extensionEligible: targetQueryBudget < budget.hardCap };
}
