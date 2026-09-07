import { optimizeRouteBuckets, precheckRouteFeasibility, type RouteObjective } from "./route-optimizer.ts";

export interface BenchmarkScenario {
  id: string;
  profile: { days: number; pace: string; dayStart: string; dayEnd: string };
  knowledge: {
    spots: Array<Record<string, unknown> & { id: string }>;
    trafficMatrix: { legs: Array<{ fromId: string; toId: string; durationMin: number; expected: number; p80: number }> };
    weather?: Array<Record<string, unknown>>;
  };
  objective: RouteObjective;
}

export interface BenchmarkReport {
  scenarioCount: number;
  hardFeasibilityRate: number;
  mustVisitCoverage: number;
  averageTransitMinutes: number;
  averageCriticalSlackMinutes: number;
  averageFatigueScore: number;
  lnsAcceptanceRate: number;
  deterministicSuccessRate: number;
}

export function fixedBenchmarkScenarios(count = 120): BenchmarkScenario[] {
  const objectives: RouteObjective[] = ["hot", "niche", "relax"];
  return Array.from({ length: count }, (_, index) => {
    const days = 1 + index % 7;
    const spotCount = Math.min(28, days * 4 + 3);
    const spots = Array.from({ length: spotCount }, (__, spotIndex) => ({
      id: `s${index}-${spotIndex}`,
      name: `固定场景${index + 1}景点${spotIndex + 1}`,
      requiredByUser: spotIndex < Math.min(days, 3),
      plannerScore: 55 + (spotIndex * 7 + index) % 42,
      recommendedDurationMin: 60 + (spotIndex % 4) * 25,
      openingHours: spotIndex % 6 === 0 ? "09:30-17:00" : "09:00-21:30",
      category: ["城市建筑", "博物馆", "特色交通", "街区"][spotIndex % 4],
      experienceTags: [["architecture"], ["museum", "indoor"], ["transport"], ["city-walk"]][spotIndex % 4],
      lat: 22.28 + spotIndex * 0.006,
      lng: 114.15 + ((spotIndex * 5) % 9) * 0.008,
      scoreConfidence: { overall: 0.45 + (spotIndex % 5) * 0.1 },
    }));
    const legs = spots.flatMap((from, fromIndex) => spots.filter((to) => to.id !== from.id).slice(0, 5).map((to, edgeIndex) => ({
      fromId: from.id,
      toId: to.id,
      durationMin: 8 + Math.abs(fromIndex - spots.indexOf(to)) * 6 + edgeIndex,
      expected: 8 + Math.abs(fromIndex - spots.indexOf(to)) * 6 + edgeIndex,
      p80: 13 + Math.abs(fromIndex - spots.indexOf(to)) * 7 + edgeIndex,
    })));
    return {
      id: `benchmark-${String(index + 1).padStart(3, "0")}`,
      profile: { days, pace: index % 4 === 0 ? "relaxed" : "normal", dayStart: "09:30", dayEnd: "21:30" },
      knowledge: { spots, trafficMatrix: { legs }, weather: Array.from({ length: days }, (___, day) => ({ precipitationProbability: (index * 13 + day * 17) % 100 })) },
      objective: objectives[index % objectives.length],
    };
  });
}

export function runOfflineBenchmark(scenarios: BenchmarkScenario[]): BenchmarkReport {
  const rows = scenarios.map((scenario) => {
    const feasibility = precheckRouteFeasibility(scenario);
    const result = optimizeRouteBuckets(scenario);
    return { feasibility, result };
  });
  const covered = rows.reduce((sum, row) => sum + row.result.diagnostics.requiredCovered, 0);
  const required = rows.reduce((sum, row) => sum + row.result.diagnostics.requiredTotal, 0);
  const average = (selector: (row: typeof rows[number]) => number) => Number((rows.reduce((sum, row) => sum + selector(row), 0) / Math.max(1, rows.length)).toFixed(3));
  return {
    scenarioCount: rows.length,
    hardFeasibilityRate: average((row) => Number(row.feasibility.feasible && row.result.diagnostics.infeasibleRequiredIds.length === 0)),
    mustVisitCoverage: Number((covered / Math.max(1, required)).toFixed(3)),
    averageTransitMinutes: average((row) => row.result.diagnostics.estimatedTransitMinutes),
    averageCriticalSlackMinutes: average((row) => row.result.diagnostics.criticalSlackMin),
    averageFatigueScore: average((row) => row.result.diagnostics.fatigueScore),
    lnsAcceptanceRate: average((row) => Number(row.result.diagnostics.lnsMoves > 0)),
    deterministicSuccessRate: average((row) => Number(row.result.selectedIds.length > 0)),
  };
}
