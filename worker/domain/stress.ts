import type { BufferAnalysis, DependencyGraph, StressResult, StressScenario, StressScenarioResult } from "./types.ts";

function selectNode(graph: DependencyGraph, scenarioId: StressScenario["id"]): string | null {
  const attractions = graph.nodes.filter((node) => node.kind === "attraction");
  const legs = graph.nodes.filter((node) => node.kind === "leg");
  if (scenarioId === "late-start") return attractions[0]?.id ?? null;
  if (scenarioId === "transit-delay") return [...legs].sort((left, right) => right.durationMin - left.durationMin)[0]?.id ?? null;
  if (scenarioId === "closure") return attractions.find((node) => node.required)?.id ?? attractions[0]?.id ?? null;
  if (scenarioId === "fatigue") return [...attractions].reverse().find((node) => !node.required)?.id ?? attractions.at(-1)?.id ?? null;
  if (scenarioId === "queue-delay") return [...attractions].sort((left, right) => right.durationMin - left.durationMin)[0]?.id ?? null;
  return attractions.find((node) => !node.required)?.id ?? attractions[0]?.id ?? null;
}

function reachable(graph: DependencyGraph, startId: string | null): string[] {
  if (!startId) return [];
  const outgoing = new Map<string, string[]>();
  graph.edges.forEach((edge) => outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]));
  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return [...seen];
}

export function runStressTest(graph: DependencyGraph, buffers: BufferAnalysis): StressResult {
  const definitions: Array<Omit<StressScenario, "targetNodeId">> = [
    { id: "late-start", name: "晚出发 45 分钟", type: "simulation", delayMinutes: 45, basis: "首个执行节点整体后移 45 分钟" },
    { id: "queue-delay", name: "最长景点排队增加 60 分钟", type: "simulation", delayMinutes: 60, basis: "将持续时间最长的景点节点增加 60 分钟" },
    { id: "transit-delay", name: "最长交通段延误 30 分钟", type: "simulation", delayMinutes: 30, basis: "在依赖图中最长交通节点增加 30 分钟" },
    { id: "rain", name: "一个户外节点遇雨", type: "simulation", delayMinutes: 35, basis: "测试一个非必选景点节点受天气干扰后的传播" },
    { id: "closure", name: "关键景点临时关闭", type: "simulation", delayMinutes: 75, basis: "从依赖图移除一个必选或关键景点节点" },
    { id: "fatigue", name: "体力下降、减少末尾节点", type: "simulation", delayMinutes: 40, basis: "测试末尾非必选节点被取消时的最小修复" },
  ];
  const scenarios: StressScenarioResult[] = definitions.map((definition) => {
    const targetNodeId = selectNode(graph, definition.id);
    const target = graph.nodes.find((node) => node.id === targetNodeId);
    const dayBuffer = buffers.daily.find((item) => item.day === target?.day)?.effectiveBufferMinutes ?? 0;
    const closurePenalty = definition.id === "closure" && target?.required ? 30 : 0;
    const effectiveDelay = definition.delayMinutes + closurePenalty;
    const overflowMinutes = Math.max(0, effectiveDelay - dayBuffer);
    const affectedNodeIds = reachable(graph, targetNodeId);
    const repairable = Boolean(target?.hasAlternative) || definition.id === "fatigue" || overflowMinutes <= 35;
    const outcome = overflowMinutes === 0 ? "resilient" : repairable ? "repairable" : "fragile";
    return {
      ...definition,
      targetNodeId,
      outcome,
      affectedNodeIds,
      overflowMinutes,
      propagatedDelayMinutes: Math.max(0, effectiveDelay - Math.min(dayBuffer, effectiveDelay)),
      suggestedRepair: outcome === "resilient"
        ? "现有缓冲可吸收，无需改变景点节点"
        : outcome === "repairable"
          ? "优先缩短或替换目标节点，并保持其他日期不变"
          : "该扰动会影响关键节点，需要对受影响日进行局部重排序",
    };
  });
  return {
    type: "simulation",
    label: "节点级情景模拟（不是天气、客流或成功率预测）",
    scenarios,
    resilientCount: scenarios.filter((item) => item.outcome === "resilient").length,
    repairableCount: scenarios.filter((item) => item.outcome === "repairable").length,
  };
}

