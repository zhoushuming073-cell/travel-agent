import { isCriticalFact, pageStatusEvidenceCeiling, sourceFitFor } from "./research-policy.ts";
import type { ResearchEvidence, ResearchGap, ResearchMetrics, SourceTier, SynthesizedFact } from "./research-types.ts";

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

export function scoreResearchEvidence(evidence: ResearchEvidence) {
  const score =
    0.25 * clamp01(evidence.entityMatchConfidence) +
    0.20 * clamp01(evidence.relevance) +
    0.15 * clamp01(evidence.sourceFit || sourceFitFor(evidence.questionType, evidence.sourceTier)) +
    0.15 * clamp01(evidence.authority) +
    0.15 * clamp01(evidence.freshness) +
    0.10 * clamp01(evidence.specificity) -
    0.18 * clamp01(evidence.commercialBias) -
    0.22 * clamp01(evidence.seoRisk);
  const ceiling = pageStatusEvidenceCeiling(evidence.pageStatus, isCriticalFact(evidence.questionType));
  const rejectionReasons: string[] = [];
  if (evidence.entityMatchConfidence < 0.55) rejectionReasons.push("entity_mismatch");
  if (evidence.relevance < 0.45) rejectionReasons.push("low_relevance");
  if (evidence.freshness <= 0 && evidence.questionType !== "internal_route") rejectionReasons.push("stale_source");
  if (ceiling === "reject") rejectionReasons.push(`page_${evidence.pageStatus}`);
  const disposition: ResearchEvidence["disposition"] = rejectionReasons.length || score < 0.5 || ceiling === "reject" ? "reject" : score >= 0.72 && ceiling !== "weak" ? "accept" : "weak";
  return { ...evidence, sourceFit: sourceFitFor(evidence.questionType, evidence.sourceTier), disposition, rejectionReasons, score: Number(score.toFixed(3)) };
}

function normalizedPassage(value: string) {
  return clean(value).toLowerCase().replace(/[\p{P}\p{S}]/gu, "").slice(0, 600);
}

export function deduplicateEvidence(evidence: ResearchEvidence[]) {
  const groups = new Map<string, ResearchEvidence[]>();
  for (const row of evidence) {
    const key = row.independenceGroupId || row.contentHash || `${row.publisher}|${normalizedPassage(row.passage)}`;
    const existing = groups.get(key) || [];
    existing.push(row);
    groups.set(key, existing);
  }
  const independent = [...groups.values()].map((rows) => [...rows].sort((left, right) => {
    const leftScore = scoreResearchEvidence(left) as ResearchEvidence & { score: number };
    const rightScore = scoreResearchEvidence(right) as ResearchEvidence & { score: number };
    return rightScore.score - leftScore.score;
  })[0]);
  return { independent, groups, dedupRatio: evidence.length ? Number((1 - independent.length / evidence.length).toFixed(3)) : 0 };
}

function valueKey(value: unknown) {
  if (value == null) return "unknown";
  if (typeof value === "string") return clean(value).toLowerCase();
  return JSON.stringify(value, Object.keys(value as object).sort());
}

export function synthesizeFact(targetId: string, targetName: string, factType: ResearchEvidence["questionType"], rows: ResearchEvidence[], now = new Date().toISOString()): SynthesizedFact {
  const scored = rows.map(scoreResearchEvidence).filter((row) => row.disposition !== "reject");
  const { independent } = deduplicateEvidence(scored);
  if (!independent.length) return { id: `fact:${targetId}:${factType}`, targetId, targetName, factType, value: null, status: "unknown", confidence: 0, supportingEvidenceIds: [], conflictingEvidenceIds: [], fetchedAt: now, reasoningSummary: "没有通过实体、时效和来源质量校验的证据" };
  const byValue = new Map<string, ResearchEvidence[]>();
  for (const row of independent) {
    const key = valueKey(row.extractedValue);
    const values = byValue.get(key) || [];
    values.push(row);
    byValue.set(key, values);
  }
  const ranked = [...byValue.entries()].map(([key, values]) => ({ key, values, weight: values.reduce((sum, value) => sum + scoreResearchEvidence(value).score, 0) })).sort((left, right) => right.weight - left.weight);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const conflict = Boolean(runnerUp && runnerUp.weight >= Math.max(0.65, winner.weight * 0.72));
  const officialFetched = winner.values.some((row) => row.sourceTier === "tier_1_official" && row.pageStatus === "page_fetched");
  const confidence = Number(Math.min(0.97, winner.weight / Math.max(1, winner.values.length)).toFixed(3));
  const conflictDominance = runnerUp ? winner.weight / Math.max(0.01, winner.weight + runnerUp.weight) : 1;
  const conflictConfidence = Number(Math.min(0.72, Math.max(0.35, confidence * conflictDominance + (officialFetched ? 0.12 : 0))).toFixed(3));
  const allConflictIds = conflict ? ranked.slice(1).flatMap((group) => group.values.map((row) => row.id)) : [];
  return {
    id: `fact:${targetId}:${factType}`,
    targetId,
    targetName,
    factType,
    value: winner.values[0].extractedValue,
    conservativeValue: conflict ? conservativeValue(ranked.flatMap((group) => group.values.map((row) => row.extractedValue)), factType) : undefined,
    status: conflict ? "conflicting" : officialFetched ? "verified" : confidence >= 0.68 ? "supported" : "inferred",
    confidence: conflict ? conflictConfidence : confidence,
    supportingEvidenceIds: winner.values.map((row) => row.id),
    conflictingEvidenceIds: allConflictIds,
    fetchedAt: now,
    validFrom: winner.values.map((row) => row.validFrom).filter(Boolean).sort()[0],
    validTo: winner.values.map((row) => row.validTo).filter(Boolean).sort().at(-1),
    reasoningSummary: conflict ? "独立来源对同一事实给出不同值；保留冲突并向规划器提供保守边界" : officialFetched ? "由可读取的官方来源支持" : `由 ${winner.values.length} 个独立来源支持`,
  };
}

function conservativeValue(values: unknown[], factType: ResearchEvidence["questionType"]) {
  if (factType === "opening_hours" || factType === "special_opening_hours") {
    const closes = values.map((value) => typeof value === "object" && value ? String((value as Record<string, unknown>).close || "") : "").filter((value) => /^\d{2}:\d{2}$/.test(value)).sort();
    if (closes.length) return { close: closes[0] };
  }
  return null;
}

export function researchMetrics(input: { rawResultCount: number; pageReadCount: number; evidence: ResearchEvidence[]; facts: SynthesizedFact[]; gaps: ResearchGap[]; searchCount: number; aiCallCount: number; realizedInformationGain: number }): ResearchMetrics {
  const accepted = input.evidence.filter((row) => row.disposition !== "reject");
  const { independent, dedupRatio } = deduplicateEvidence(accepted);
  const tiers: Record<SourceTier, number> = { tier_1_official: 0, tier_2_professional: 0, tier_3_news: 0, tier_4_ugc: 0, unknown: 0 };
  independent.forEach((row) => { tiers[row.sourceTier] += 1; });
  const totalImpact = input.gaps.reduce((sum, gap) => sum + gap.decisionImpact, 0);
  const resolvedIds = new Set(input.facts.filter((fact) => fact.status !== "unknown").map((fact) => `${fact.targetId}:${fact.factType}`));
  const resolvedImpact = input.gaps.filter((gap) => resolvedIds.has(`${gap.targetId}:${gap.factType}`)).reduce((sum, gap) => sum + gap.decisionImpact, 0);
  const dynamicFacts = input.facts.filter((fact) => ["temporary_closure", "special_opening_hours", "seasonal_event", "festival", "flower_season", "crowd_pattern", "queue_pattern", "transit_change", "construction"].includes(fact.factType));
  const freshDynamic = dynamicFacts.filter((fact) => fact.status === "verified" || fact.status === "supported");
  return {
    rawResultCount: input.rawResultCount,
    fetchedPageCount: input.pageReadCount,
    acceptedEvidenceCount: accepted.length,
    independentEvidenceCount: independent.length,
    evidenceDedupRatio: dedupRatio,
    sourceTierDistribution: tiers,
    freshnessCoverage: dynamicFacts.length ? Number((freshDynamic.length / dynamicFacts.length).toFixed(3)) : 1,
    decisionImpactCoverage: totalImpact ? Number((resolvedImpact / totalImpact).toFixed(3)) : 1,
    searchCount: input.searchCount,
    pageReadCount: input.pageReadCount,
    aiCallCount: input.aiCallCount,
    realizedInformationGain: Number(input.realizedInformationGain.toFixed(3)),
  };
}
