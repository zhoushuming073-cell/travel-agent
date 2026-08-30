import type { DecisionTrace, SynthesizedFact } from "./research-types.ts";

const text = (value: unknown) => String(value ?? "").trim();
const list = <T = any>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export function buildResearchDecisionTrace(plan: any, research: any): DecisionTrace[] {
  const facts = list<SynthesizedFact>(research?.facts);
  const factsByTarget = new Map<string, SynthesizedFact[]>();
  for (const fact of facts) factsByTarget.set(fact.targetId, [...(factsByTarget.get(fact.targetId) || []), fact]);
  const traces: DecisionTrace[] = [];
  for (const day of list<any>(plan?.daysPlan)) {
    let previous: any = null;
    for (const item of list<any>(day?.items)) {
      const targetFacts = factsByTarget.get(item.id) || [];
      const evidenceIds = [...new Set(targetFacts.flatMap((fact) => fact.supportingEvidenceIds || []))];
      const userPreferenceIds = list<string>(item.matchedPreferences);
      const reasonParts = [
        item.requiredByUser ? "用户明确必去" : "候选池目标函数入选",
        userPreferenceIds.length ? `匹配偏好 ${userPreferenceIds.join("/")}` : "",
        targetFacts.length ? `${targetFacts.length} 个研究事实参与` : "没有可用研究事实，保留不确定性",
      ].filter(Boolean);
      traces.push({
        decisionId: `${plan.id}:${day.day}:${item.id}:selected`,
        decisionType: "spot_selected",
        variantId: plan.id,
        day: Number(day.day),
        targetIds: [item.id],
        userPreferenceIds,
        factIds: targetFacts.map((fact) => fact.id),
        evidenceIds,
        algorithmConstraintIds: [
          `plannerScore=${Number(item.plannerScore ?? 0)}`,
          `crowdRisk=${item.crowd?.score ?? "Unknown"}`,
          `required=${Boolean(item.requiredByUser)}`,
        ],
        resultingDecision: `${item.startTime}-${item.endTime} 安排 ${item.name}；${reasonParts.join("；")}${text(item.recommendationReason || item.reason) ? `；AI理由：${text(item.recommendationReason || item.reason)}` : ""}`,
        counterfactual: item.requiredByUser ? "必去约束使该景点不可删除，只能调整日期或时段" : "若偏好得分、开放可行性或交通边际收益下降，该景点会被同类候选替换",
      });
      traces.push({
        decisionId: `${plan.id}:${day.day}:${item.id}:time`,
        decisionType: "visit_time",
        variantId: plan.id,
        day: Number(day.day),
        targetIds: [item.id],
        userPreferenceIds,
        factIds: targetFacts.filter((fact) => ["opening_hours", "special_opening_hours", "crowd_pattern", "queue_pattern", "weekend_crowd", "holiday_crowd"].includes(fact.factType)).map((fact) => fact.id),
        evidenceIds,
        algorithmConstraintIds: [`start=${item.startTime}`, `end=${item.endTime}`, `opening=${item.openingHours || "Unknown"}`, `crowd=${item.crowd?.score ?? "Unknown"}`],
        resultingDecision: `在 ${item.startTime}-${item.endTime} 到访；AI 提议时段，Travel Compiler 结合开放时间、相邻交通、用餐和日界限校验并可能顺延`,
        counterfactual: "若开放时间、预约或可比日期客流证据改变，系统应重排该时段或启用替代点",
      });
      if (previous) {
        const leg = list<any>(day.blocks).find((block) => block.type === "leg" && block.from === previous.name && block.to === item.name);
        traces.push({
          decisionId: `${plan.id}:${day.day}:${previous.id}:${item.id}:transit`,
          decisionType: "transit_choice",
          variantId: plan.id,
          day: Number(day.day),
          targetIds: [previous.id, item.id],
          userPreferenceIds: [], factIds: [], evidenceIds: [],
          algorithmConstraintIds: [`from=${previous.name}`, `durationMin=${leg?.durationMin ?? "Unknown"}`, `source=${leg?.source || "Unknown"}`, `quality=${leg?.quality || "Unknown"}`],
          resultingDecision: "相邻景点顺序由 AI 方案与交通矩阵共同决定；最终段由后端地图服务复核",
          counterfactual: "若地图返回更长交通时间，编译器会顺延、换序或移除非必选节点",
        });
      }
      previous = item;
    }
  }
  return traces;
}

export function traceCoverage(traces: DecisionTrace[]) {
  const decisions = traces.filter((trace) => trace.decisionType === "spot_selected" || trace.decisionType === "visit_time");
  const withEvidence = decisions.filter((trace) => trace.evidenceIds.length || trace.userPreferenceIds.length || trace.algorithmConstraintIds.length);
  return {
    decisionCount: decisions.length,
    tracedDecisionCount: withEvidence.length,
    coverage: decisions.length ? Number((withEvidence.length / decisions.length).toFixed(3)) : 0,
  };
}
