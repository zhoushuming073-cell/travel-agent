import type { BufferAnalysis, DependencyGraph, RobustnessSimulation, UnknownAnalysis } from "./types.ts";

function randomFactory(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

export function simulatePlanRobustness(
  graph: DependencyGraph,
  buffers: BufferAnalysis,
  unknowns: UnknownAnalysis,
  seed: number,
  runs = 400,
): RobustnessSimulation {
  const random = randomFactory(seed);
  const days = [...new Set(graph.nodes.map((node) => node.day))];
  const criticalUnknownRate = Math.min(0.18, unknowns.importantCount * 0.018);
  const delays: number[] = [];
  let onTime = 0;
  let hardSuccess = 0;
  let dropped = 0;
  for (let run = 0; run < runs; run += 1) {
    let totalOverflow = 0;
    let hardFailed = false;
    let droppedOptional = 0;
    for (const day of days) {
      const nodes = graph.nodes.filter((node) => node.day === day && (node.kind === "attraction" || node.kind === "leg"));
      const stochasticDelay = nodes.reduce((sum, node) => {
        const base = node.kind === "leg" ? 18 : 12;
        const tail = random() > 0.88 ? base * (1 + random() * 2.5) : random() * base;
        if (node.required && random() < criticalUnknownRate) hardFailed = true;
        return sum + tail;
      }, 0);
      const buffer = buffers.daily.find((item) => item.day === day)?.effectiveBufferMinutes || 0;
      const overflow = Math.max(0, Math.round(stochasticDelay - buffer));
      totalOverflow += overflow;
      droppedOptional += Math.min(nodes.filter((node) => !node.required && node.kind === "attraction").length, Math.ceil(overflow / 75));
    }
    if (totalOverflow === 0) onTime += 1;
    if (!hardFailed) hardSuccess += 1;
    delays.push(totalOverflow);
    dropped += droppedOptional;
  }
  return {
    type: "simulation",
    version: "1.0",
    runs,
    seed,
    onTimeRate: Number((onTime / runs).toFixed(3)),
    hardConstraintSuccessRate: Number((hardSuccess / runs).toFixed(3)),
    p50DelayMinutes: percentile(delays, 0.5),
    p90DelayMinutes: percentile(delays, 0.9),
    expectedDroppedOptionalStops: Number((dropped / runs).toFixed(2)),
    note: "基于依赖节点、缓冲和关键未知的可重复蒙特卡洛压力模拟，不是现实事件发生概率承诺。",
  };
}
