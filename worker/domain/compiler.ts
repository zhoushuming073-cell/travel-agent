import type {
  BufferAnalysis,
  CompilerIssue,
  CompilerResult,
  DependencyGraph,
  ItineraryPlan,
  TravelFact,
  TravelProfile,
  UnknownAnalysis,
} from "./types.ts";

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[\s·・—_\-（）()]/g, "");
}

function requiredCoverage(plan: ItineraryPlan, profile: TravelProfile): boolean {
  const names = plan.daysPlan.flatMap((day) => day.items.map((item) => normalized(item.name)));
  return profile.requiredAttractions.every((required) => {
    const expected = normalized(required);
    return names.some((actual) => actual.includes(expected) || expected.includes(actual));
  });
}

function chronologyValid(plan: ItineraryPlan): boolean {
  return plan.daysPlan.every((day) => day.blocks.every((block) => {
    if (!block.startTime || !block.endTime) return true;
    return block.startTime <= block.endTime;
  }));
}

function routeContinuity(plan: ItineraryPlan): boolean {
  return plan.daysPlan.every((day) => {
    const attractionCount = day.blocks.filter((block) => block.type === "attraction").length;
    const legCount = day.blocks.filter((block) => block.type === "leg").length;
    return attractionCount <= 1 || legCount >= attractionCount - 1;
  });
}

export function compileItinerary(
  plan: ItineraryPlan,
  profile: TravelProfile,
  facts: TravelFact[],
  graph: DependencyGraph,
  buffers: BufferAnalysis,
  unknowns: UnknownAnalysis,
): CompilerResult {
  const checks = {
    requiredCoverage: requiredCoverage(plan, profile),
    dayCount: plan.daysPlan.length === profile.days,
    chronology: chronologyValid(plan),
    openingConflicts: facts.filter((fact) => /开放时间|开放状态提醒/.test(fact.field) && fact.status === "conflicting").length,
    routeContinuity: routeContinuity(plan),
  };
  const issues: CompilerIssue[] = [];
  if (!checks.requiredCoverage) issues.push({ code: "REQUIRED_MISSING", severity: "error", message: "至少一个用户必选景点未进入方案" });
  if (!checks.dayCount) issues.push({ code: "DAY_COUNT", severity: "error", message: "方案天数与用户需求不一致" });
  if (!checks.chronology) issues.push({ code: "TIME_ORDER", severity: "error", message: "存在结束时间早于开始时间的节点" });
  if (!checks.routeContinuity) issues.push({ code: "ROUTE_GAP", severity: "warning", message: "部分相邻景点缺少交通依赖段" });
  if (checks.openingConflicts) issues.push({ code: "OPENING_CONFLICT", severity: "warning", message: `${checks.openingConflicts} 个开放时间事实存在来源冲突` });
  if (buffers.minBufferMinutes < 20) issues.push({ code: "LOW_BUFFER", severity: "warning", message: `最小有效缓冲仅 ${buffers.minBufferMinutes} 分钟` });
  if (unknowns.criticalUnknown) issues.push({ code: "CRITICAL_UNKNOWN", severity: "warning", message: `关键未知：${unknowns.criticalUnknown.subject} ${unknowns.criticalUnknown.field}` });

  const knownFacts = facts.filter((fact) => !["unknown", "conflicting", "stale"].includes(fact.status)).length;
  const informationCompleteness = facts.length ? Math.round(knownFacts / facts.length * 100) : 0;
  const constraintScore = checks.requiredCoverage && checks.dayCount ? 100 : checks.requiredCoverage || checks.dayCount ? 50 : 0;
  const structuralPenalty = issues.reduce((sum, issue) => sum + (issue.severity === "error" ? 18 : issue.severity === "warning" ? 5 : 1), 0);
  const graphCoverage = plan.daysPlan.length ? Math.min(100, Math.round(graph.nodes.length / Math.max(1, plan.daysPlan.flatMap((day) => day.blocks).length + plan.daysPlan.length * 2) * 100)) : 0;
  const evaluationScore = plan.evaluation?.overall ?? 65;
  const reliability = clamp(Math.round(
    evaluationScore * 0.36
    + informationCompleteness * 0.24
    + constraintScore * 0.2
    + Math.min(100, buffers.minBufferMinutes * 2) * 0.12
    + graphCoverage * 0.08
    - structuralPenalty,
  ));
  const weatherFacts = facts.filter((fact) => fact.field === "逐日预报");
  const crowdFacts = facts.filter((fact) => fact.field === "拥挤风险");
  const reservationFacts = facts.filter((fact) => fact.field === "预约状态");
  const weatherRisk = weatherFacts.some((fact) => ["unknown", "conflicting", "stale"].includes(fact.status))
    ? "unknown"
    : weatherFacts.some((fact) => typeof fact.value === "object" && fact.value !== null && Number((fact.value as Record<string, unknown>).precipitationProbability ?? 0) >= 60)
      ? "medium"
      : "low";
  const reservationUnknowns = reservationFacts.filter((fact) => ["unknown", "conflicting", "stale"].includes(fact.status));

  return {
    version: "2.0",
    reliability,
    informationCompleteness,
    minBufferMinutes: buffers.minBufferMinutes,
    constraintScore,
    timeRisk: buffers.minBufferMinutes < 20 ? "high" : buffers.minBufferMinutes < 35 ? "medium" : "low",
    weatherRisk,
    crowdRisk: crowdFacts.some((fact) => fact.status === "predicted") ? "predicted" : "unknown",
    reservationRisk: reservationUnknowns.some((fact) => fact.importance === "high") ? "high" : reservationUnknowns.length ? "medium" : "low",
    status: issues.some((issue) => issue.severity === "error")
      ? "不可执行：存在硬约束错误"
      : reliability >= 78 && unknowns.importantCount === 0
        ? "可执行"
        : reliability >= 55
          ? "可执行，但需完成关键核验"
          : "风险较高，建议先核验再出发",
    note: "由事实状态、硬约束、依赖图、路线时序和真实缓冲计算；不是模型自报分数。",
    issues,
    checks,
  };
}
