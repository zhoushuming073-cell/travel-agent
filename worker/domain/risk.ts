import type { BufferAnalysis, DependencyGraph, FragilityResult, ItineraryPlan, UnknownAnalysis } from "./types.ts";

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function analyzeFragility(
  plan: ItineraryPlan,
  graph: DependencyGraph,
  buffers: BufferAnalysis,
  unknowns: UnknownAnalysis,
): FragilityResult {
  const outgoing = new Map<string, number>();
  graph.edges.forEach((edge) => outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1));
  const vulnerableNodes = graph.nodes
    .filter((node) => node.kind === "attraction" || node.kind === "leg")
    .map((node) => {
      const reasons: string[] = [];
      let score = 0;
      if (node.required) { score += 34; reasons.push("用户硬约束"); }
      if (node.fixed) { score += 12; reasons.push("固定依赖节点"); }
      if (!node.hasAlternative && node.kind === "attraction") { score += 18; reasons.push("没有已核验替代点"); }
      if ((outgoing.get(node.id) ?? 0) > 0) { score += 12; reasons.push("失败会影响后续节点"); }
      const dayBuffer = buffers.daily.find((item) => item.day === node.day)?.effectiveBufferMinutes ?? 0;
      if (dayBuffer < 30) { score += 18; reasons.push(`Day ${node.day} 缓冲不足`); }
      return { nodeId: node.id, label: node.label, reasons, score: clamp(score) };
    })
    .filter((node) => node.score >= 30)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  const fixedNodeCount = graph.nodes.filter((node) => node.fixed && !node.kind.startsWith("day-")).length;
  const singlePointFailureCount = vulnerableNodes.filter((node) => node.score >= 64).length;
  const alternativesAvailable = plan.candidatePool?.filter((item) => !item.selected).length ?? 0;
  const averageVulnerability = vulnerableNodes.length ? vulnerableNodes.reduce((sum, node) => sum + node.score, 0) / vulnerableNodes.length : 0;
  const score = clamp(Math.round(
    averageVulnerability * 0.35
    + Math.max(0, 45 - buffers.minBufferMinutes) * 0.7
    + unknowns.importantCount * 6
    + singlePointFailureCount * 5
    - Math.min(12, alternativesAvailable * 2),
  ));
  return {
    score,
    level: score >= 70 ? "high" : score >= 42 ? "medium" : "low",
    fixedNodeCount,
    dependencyCount: graph.edges.length,
    singlePointFailureCount,
    minBufferMinutes: buffers.minBufferMinutes,
    alternativesAvailable,
    vulnerableNodes,
    note: "分数越高越脆弱；依据真实依赖、固定节点、关键未知、替代点和有效缓冲计算。",
  };
}

