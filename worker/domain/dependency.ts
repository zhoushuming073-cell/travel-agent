import type {
  BufferAnalysis,
  CriticalPath,
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  ItineraryBlock,
  ItineraryPlan,
  TravelProfile,
} from "./types.ts";

export function timeToMinutes(value: string | undefined, fallback: number): number {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return fallback;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function nodeKind(block: ItineraryBlock): DependencyNode["kind"] {
  if (block.type === "attraction") return "attraction";
  if (block.type === "leg") return "leg";
  return "rest";
}

function blockLabel(block: ItineraryBlock): string {
  if (block.type === "attraction") return block.item?.name ?? "景点";
  if (block.type === "leg") return `${block.from ?? "上一站"} → ${block.to ?? "下一站"}`;
  return block.label ?? "休息";
}

export function buildDependencyGraph(plan: ItineraryPlan, profile: TravelProfile): DependencyGraph {
  const nodes: DependencyNode[] = [];
  const edges: DependencyEdge[] = [];
  const defaultStart = timeToMinutes(profile.dayStart, 9 * 60);
  const defaultEnd = timeToMinutes(profile.dayEnd, 21 * 60);

  for (const day of plan.daysPlan) {
    const dayStart = `day-${day.day}-start`;
    const dayEnd = `day-${day.day}-end`;
    nodes.push({ id: dayStart, day: day.day, kind: "day-start", label: `Day ${day.day} 开始`, durationMin: 0, startMinute: defaultStart, endMinute: defaultStart, fixed: true, required: false, hasAlternative: false });
    let previousId = dayStart;
    let cursor = defaultStart;
    day.blocks.forEach((block, index) => {
      const startMinute = timeToMinutes(block.startTime, cursor);
      const durationMin = Math.max(0, block.durationMin ?? (timeToMinutes(block.endTime, startMinute) - startMinute));
      const endMinute = timeToMinutes(block.endTime, startMinute + durationMin);
      const required = Boolean(block.item?.requiredByUser);
      const id = `day-${day.day}-${block.type}-${index + 1}-${block.item?.id ?? "node"}`;
      nodes.push({
        id,
        day: day.day,
        kind: nodeKind(block),
        label: blockLabel(block),
        durationMin,
        startMinute,
        endMinute,
        fixed: required || block.type === "leg",
        required,
        hasAlternative: block.type === "attraction" && !required && Boolean(plan.candidatePool?.some((item) => !item.selected)),
      });
      edges.push({ id: `edge-${previousId}-${id}`, from: previousId, to: id, relation: block.type === "leg" ? "travel" : required ? "hard-constraint" : "sequence", lagMinutes: 0 });
      previousId = id;
      cursor = endMinute;
    });
    nodes.push({ id: dayEnd, day: day.day, kind: "day-end", label: `Day ${day.day} 结束`, durationMin: 0, startMinute: defaultEnd, endMinute: defaultEnd, fixed: true, required: false, hasAlternative: false });
    edges.push({ id: `edge-${previousId}-${dayEnd}`, from: previousId, to: dayEnd, relation: "sequence", lagMinutes: 0 });
  }
  return { nodes, edges };
}

export function analyzeBuffers(plan: ItineraryPlan, profile: TravelProfile): BufferAnalysis {
  const endLimit = timeToMinutes(profile.dayEnd, 21 * 60);
  const daily = plan.daysPlan.map((day) => {
    const explicitBufferMinutes = day.blocks
      .filter((block) => block.type === "rest" && /弹性|备用|缓冲/.test(block.label ?? ""))
      .reduce((sum, block) => sum + Math.max(0, block.durationMin ?? 0), 0);
    const endTimes = day.blocks.map((block) => timeToMinutes(block.endTime, 0)).filter((value) => value > 0);
    const actualEnd = endTimes.length ? Math.max(...endTimes) : timeToMinutes(profile.dayStart, 9 * 60);
    const endSlackMinutes = Math.max(0, endLimit - actualEnd);
    return { day: day.day, explicitBufferMinutes, endSlackMinutes, effectiveBufferMinutes: explicitBufferMinutes + endSlackMinutes };
  });
  const buffers = daily.map((item) => item.effectiveBufferMinutes);
  const minBufferMinutes = buffers.length ? Math.min(...buffers) : 0;
  return {
    minBufferMinutes,
    averageBufferMinutes: buffers.length ? Math.round(buffers.reduce((sum, value) => sum + value, 0) / buffers.length) : 0,
    criticalDay: daily.find((item) => item.effectiveBufferMinutes === minBufferMinutes)?.day ?? null,
    daily,
  };
}

export function calculateCriticalPath(graph: DependencyGraph): CriticalPath {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, DependencyEdge[]>();
  graph.edges.forEach((edge) => incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]));
  const ordered = [...graph.nodes].sort((left, right) => left.day - right.day || left.startMinute - right.startMinute || left.id.localeCompare(right.id));
  const distance = new Map<string, number>();
  const predecessor = new Map<string, string>();
  let finalId: string | null = null;
  let finalDistance = -1;
  for (const node of ordered) {
    let best = 0;
    let bestPredecessor: string | undefined;
    for (const edge of incoming.get(node.id) ?? []) {
      const candidate = (distance.get(edge.from) ?? 0) + edge.lagMinutes;
      if (candidate >= best) {
        best = candidate;
        bestPredecessor = edge.from;
      }
    }
    const total = best + node.durationMin;
    distance.set(node.id, total);
    if (bestPredecessor) predecessor.set(node.id, bestPredecessor);
    if (total > finalDistance) {
      finalDistance = total;
      finalId = node.id;
    }
  }
  const nodeIds: string[] = [];
  let cursor = finalId;
  while (cursor) {
    nodeIds.unshift(cursor);
    cursor = predecessor.get(cursor) ?? null;
  }
  return {
    nodeIds,
    totalMinutes: Math.max(0, finalDistance),
    nodes: nodeIds.map((id) => {
      const node = nodeById.get(id);
      const reasons = [node?.required ? "用户硬约束" : "位于最长依赖链"];
      if (node?.kind === "leg") reasons.push("交通延误会向后传播");
      return { id, name: node?.label ?? id, reason: reasons.join("；") };
    }),
    note: "关键路径由日程依赖图上的最长耗时链计算，不是按景点热度指定。",
  };
}

