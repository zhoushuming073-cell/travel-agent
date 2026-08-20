import type { ItineraryPlan, TravelFact, UnknownAnalysis, UnknownItem, VerificationItem } from "./types.ts";

const unknownStatuses = new Set(["unknown", "conflicting", "stale"]);

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function hasAlternative(plan: ItineraryPlan, fact: TravelFact): boolean {
  if (/天气|路线|交通|酒店/.test(fact.subject)) return true;
  return Boolean(plan.candidatePool?.some((item) => !item.selected && item.name !== fact.subject));
}

export function analyzeUnknowns(plan: ItineraryPlan, facts: TravelFact[], now = new Date()): UnknownAnalysis {
  const startTimestamp = Date.parse(plan.startDate);
  const daysUntilStart = Number.isFinite(startTimestamp) ? Math.ceil((startTimestamp - now.getTime()) / 86_400_000) : 30;
  const items: UnknownItem[] = facts
    .filter((fact) => unknownStatuses.has(fact.status))
    .map((fact) => {
      const alternative = hasAlternative(plan, fact);
      const userConstraint = fact.importance === "high" ? 28 : fact.importance === "medium" ? 15 : 6;
      const executionImpact = /无法执行|必选|延误传导/.test(fact.downstreamImpact) ? 28 : /改变|压缩|替代/.test(fact.downstreamImpact) ? 18 : 8;
      const timeSensitivity = daysUntilStart <= 2 ? 18 : daysUntilStart <= 7 ? 12 : daysUntilStart <= 30 ? 7 : 3;
      const evidenceRisk = fact.status === "conflicting" ? 18 : fact.status === "stale" ? 14 : 12;
      const alternativePenalty = alternative ? 0 : 8;
      const score = clamp(userConstraint + executionImpact + timeSensitivity + evidenceRisk + alternativePenalty);
      return {
        factId: fact.id,
        subject: fact.subject,
        field: fact.field,
        status: fact.status as UnknownItem["status"],
        score,
        importance: fact.importance,
        reason: fact.uncertaintyReason ?? "当前没有足够可靠的证据",
        impact: fact.downstreamImpact,
        hasAlternative: alternative,
        factors: { userConstraint, executionImpact, timeSensitivity, evidenceRisk, alternativePenalty },
      };
    })
    .sort((left, right) => right.score - left.score || left.subject.localeCompare(right.subject, "zh-CN"));

  return {
    count: items.length,
    importantCount: items.filter((item) => item.score >= 65 || item.importance === "high").length,
    items,
    criticalUnknown: items[0] ?? null,
  };
}

function actionFor(fact: TravelFact): string {
  if (fact.sourceUrl) return "打开可追溯来源，并在执行前再次核验";
  if (/预约/.test(fact.field)) return "通过景区官方预约入口核验指定日期余量";
  if (/开放/.test(fact.field)) return "查看景区官方公告或致电确认当日开放状态";
  if (/天气/.test(`${fact.subject}${fact.field}`)) return "临近出发时重新获取逐小时天气预报";
  if (/交通/.test(`${fact.subject}${fact.field}`)) return "出发前用地图服务重算实际出行时刻路线";
  return "临近执行时间重新查询可靠来源";
}

export function buildMinimumVerification(
  analysis: UnknownAnalysis,
  facts: TravelFact[],
  riskCoverageTarget = 0.72,
): VerificationItem[] {
  if (!analysis.items.length) return [];
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const totalScore = analysis.items.reduce((sum, item) => sum + item.score, 0);
  let covered = 0;
  const result: VerificationItem[] = [];
  for (const item of analysis.items) {
    if (result.length >= 6 || (result.length > 0 && covered / totalScore >= riskCoverageTarget)) break;
    const fact = byId.get(item.factId);
    covered += item.score;
    result.push({
      rank: result.length + 1,
      factId: item.factId,
      subject: item.subject,
      field: item.field,
      reason: item.reason,
      impact: item.impact,
      action: fact ? actionFor(fact) : "临近执行时间重新核验",
      priorityScore: item.score,
      cumulativeRiskCoverage: Math.round(covered / totalScore * 100),
    });
  }
  return result;
}

