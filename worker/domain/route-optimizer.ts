export type RouteObjective = "hot" | "niche" | "relax";

export interface RouteScoreBreakdown {
  preference?: number;
  poiQuality?: number;
  dataCompleteness?: number;
  seasonality?: number;
  crowdFit?: number;
}

interface RouteSpot extends Record<string, unknown> {
  id: string;
  requiredByUser?: boolean;
  timeRole?: string;
  plannerScore?: number;
  scoreBreakdown?: RouteScoreBreakdown;
  recommendedDurationMin?: number;
  openingHours?: string | null;
}

interface RouteLeg {
  fromId?: string;
  toId?: string;
  durationMin?: unknown;
  expected?: unknown;
  p80?: unknown;
}

interface TrafficMatrix { legs?: RouteLeg[]; }

export interface RouteOptimizationResult {
  dayBuckets: RouteSpot[][];
  selectedIds: string[];
  excluded: Array<{ spotId: string; reason: string }>;
  objectiveScore: number;
  diagnostics: {
    requiredCovered: number;
    requiredTotal: number;
    estimatedTransitMinutes: number;
    clusterPenalty: number;
    diversityPenalty: number;
    localSearchMoves: number;
    infeasibleRequiredIds: string[];
  };
}

export interface FeasibilityPrecheck {
  feasible: boolean;
  requiredCount: number;
  availableMinutes: number;
  lowerBoundMinutes: number;
  violations: Array<{ spotId?: string; code: "WINDOW_TOO_SHORT" | "CAPACITY_EXCEEDED"; message: string }>;
}

const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function parseClock(value: unknown) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const result = Number(match[1]) * 60 + Number(match[2]);
  return result >= 0 && result < 1440 ? result : null;
}

function openingWindow(spot: RouteSpot, dayStart: number, dayEnd: number): [number, number] {
  const explicit = Array.isArray(spot.availabilityWindows) ? spot.availabilityWindows[0] as Record<string, unknown> : null;
  if (explicit) {
    const start = parseClock(explicit.start);
    const end = parseClock(explicit.end);
    if (start !== null && end !== null && end > start) return [Math.max(dayStart, start), Math.min(dayEnd, end)];
  }
  const match = String(spot.openingHours ?? "").match(/(\d{1,2}):(\d{2})\s*[-—至]\s*(\d{1,2}):(\d{2})/);
  if (!match) return [dayStart, dayEnd];
  return [Math.max(dayStart, Number(match[1]) * 60 + Number(match[2])), Math.min(dayEnd, Number(match[3]) * 60 + Number(match[4]))];
}

function duration(spot: RouteSpot) {
  return clamp(number(spot.recommendedDurationMin, 90), 45, 240);
}

function legMinutes(matrix: TrafficMatrix | undefined, left: RouteSpot | undefined, right: RouteSpot | undefined, objective: RouteObjective = "hot") {
  if (!left || !right || left.id === right.id) return 0;
  const leg = (matrix?.legs || []).find((item) => item.fromId === left.id && item.toId === right.id)
    ?? (matrix?.legs || []).find((item) => item.fromId === right.id && item.toId === left.id);
  if (leg) {
    const expected = number(leg.expected ?? leg.durationMin, 25);
    return Math.max(1, objective === "relax" ? number(leg.p80, expected) : expected);
  }
  const lat1 = number(left.lat), lng1 = number(left.lng), lat2 = number(right.lat), lng2 = number(right.lng);
  if (!lat1 || !lng1 || !lat2 || !lng2) return 35;
  const x = (lng2 - lng1) * Math.cos((lat1 + lat2) * Math.PI / 360);
  const y = lat2 - lat1;
  return Math.max(8, Math.round(Math.sqrt(x * x + y * y) * 111 * 3.2));
}

function objectiveValue(spot: RouteSpot, objective: RouteObjective) {
  const scores = record(spot.scoreBreakdown);
  const preference = number(scores.preference ?? spot.plannerScore, 50);
  const quality = number(scores.poiQuality, 50);
  const completeness = number(scores.dataCompleteness, 45);
  const season = number(scores.seasonality ?? record(spot.seasonFit).score, 45);
  const hotness = number(record(spot.hotness).score, 40);
  const crowd = number(record(spot.crowdRisk).crowdRiskScore ?? record(spot.crowdRisk).score ?? record(spot.crowd).score, 55);
  const comfort = number(scores.crowdFit, 100 - crowd);
  const unknownPenalty = (Array.isArray(spot.unknown) ? spot.unknown : []).length * 2.5;
  if (objective === "niche") return preference * 0.30 + season * 0.25 + quality * 0.15 + completeness * 0.10 + (/(自然|摄影|独特|建筑)/.test((Array.isArray(spot.tags) ? spot.tags : []).map(String).join(" ")) ? 12 : 0) - unknownPenalty;
  if (objective === "relax") return preference * 0.30 + comfort * 0.25 + completeness * 0.20 + quality * 0.10 - unknownPenalty;
  return quality * 0.35 + preference * 0.25 + hotness * 0.20 + completeness * 0.10 + season * 0.10 - unknownPenalty;
}

function simulateDay(route: RouteSpot[], matrix: TrafficMatrix | undefined, objective: RouteObjective, start: number, end: number) {
  let cursor = start;
  let transit = 0;
  let previous: RouteSpot | undefined;
  for (const spot of route) {
    const travel = legMinutes(matrix, previous, spot, objective);
    transit += travel;
    cursor += travel;
    const [open, close] = openingWindow(spot, start, end);
    if (spot.timeRole === "nightscape") cursor = Math.max(cursor, 18 * 60);
    cursor = Math.max(cursor, open);
    cursor += duration(spot);
    if (cursor > close || cursor > end) return { feasible: false, end: cursor, transit };
    previous = spot;
  }
  return { feasible: true, end: cursor, transit };
}

function bestInsertion(route: RouteSpot[], spot: RouteSpot, matrix: TrafficMatrix | undefined, objective: RouteObjective, dayStart: number, dayEnd: number) {
  let best: { route: RouteSpot[]; cost: number } | null = null;
  for (let index = 0; index <= route.length; index += 1) {
    const candidate = [...route.slice(0, index), spot, ...route.slice(index)];
    const simulation = simulateDay(candidate, matrix, objective, dayStart, dayEnd);
    if (!simulation.feasible) continue;
    const before = route.length ? simulateDay(route, matrix, objective, dayStart, dayEnd).transit : 0;
    const crowdPenalty = objective === "relax" ? number(record(spot.crowdRisk).score ?? record(spot.crowd).score, 50) * 0.12 : 0;
    const riskPenalty = (Array.isArray(spot.unknown) ? spot.unknown.length : 0) * 3;
    const cost = simulation.transit - before + crowdPenalty + riskPenalty - objectiveValue(spot, objective) * 0.18;
    if (!best || cost < best.cost) best = { route: candidate, cost };
  }
  return best;
}

function improveRoute(route: RouteSpot[], matrix: TrafficMatrix | undefined, objective: RouteObjective, dayStart: number, dayEnd: number) {
  let current = route;
  let moves = 0;
  let improved = true;
  while (improved && moves < 20) {
    improved = false;
    const baseline = simulateDay(current, matrix, objective, dayStart, dayEnd);
    for (let left = 0; left < current.length - 1 && !improved; left += 1) {
      for (let right = left + 1; right < current.length && !improved; right += 1) {
        const candidate = [...current.slice(0, left), ...current.slice(left, right + 1).reverse(), ...current.slice(right + 1)];
        const result = simulateDay(candidate, matrix, objective, dayStart, dayEnd);
        if (result.feasible && result.transit + 1 < baseline.transit) {
          current = candidate;
          moves += 1;
          improved = true;
        }
      }
    }
  }
  return { route: current, moves };
}

export function precheckRouteFeasibility(input: {
  profile: { days?: unknown; dayStart?: string; dayEnd?: string };
  knowledge: { spots?: RouteSpot[]; trafficMatrix?: TrafficMatrix };
}): FeasibilityPrecheck {
  const days = Math.max(1, number(input.profile.days, 1));
  const dayStart = parseClock(input.profile.dayStart) ?? 9 * 60;
  const dayEnd = parseClock(input.profile.dayEnd) ?? 21 * 60;
  const required = (input.knowledge.spots || []).filter((spot) => spot.requiredByUser);
  const violations: FeasibilityPrecheck["violations"] = [];
  for (const spot of required) {
    const [open, close] = openingWindow(spot, dayStart, dayEnd);
    if (close - open < duration(spot)) {
      violations.push({ spotId: spot.id, code: "WINDOW_TOO_SHORT", message: `${spot.name || spot.id} 的可用时间窗短于建议游览时长` });
    }
  }
  const durationBound = required.reduce((sum, spot) => sum + duration(spot), 0);
  const minimumEdges = [...required].sort((left, right) => {
    const leftNearest = Math.min(...required.filter((spot) => spot.id !== left.id).map((spot) => legMinutes(input.knowledge.trafficMatrix, left, spot)), 0);
    const rightNearest = Math.min(...required.filter((spot) => spot.id !== right.id).map((spot) => legMinutes(input.knowledge.trafficMatrix, right, spot)), 0);
    return leftNearest - rightNearest;
  }).slice(0, Math.max(0, required.length - days));
  const transitBound = minimumEdges.reduce((sum, spot) => {
    const nearest = required.filter((candidate) => candidate.id !== spot.id).map((candidate) => legMinutes(input.knowledge.trafficMatrix, spot, candidate));
    return sum + (nearest.length ? Math.min(...nearest) : 0);
  }, 0);
  const mealBound = days * 60;
  const lowerBoundMinutes = durationBound + transitBound + mealBound;
  const availableMinutes = days * Math.max(0, dayEnd - dayStart);
  if (lowerBoundMinutes > availableMinutes) {
    violations.push({ code: "CAPACITY_EXCEEDED", message: `必去项、最低交通与用餐至少需要 ${lowerBoundMinutes} 分钟，超过 ${availableMinutes} 分钟可用时段` });
  }
  return { feasible: violations.length === 0, requiredCount: required.length, availableMinutes, lowerBoundMinutes, violations };
}

export function optimizeRouteBuckets(input: {
  profile: { days?: unknown; pace?: string; dayStart?: string; dayEnd?: string };
  knowledge: { spots?: RouteSpot[]; trafficMatrix?: TrafficMatrix };
  objective: RouteObjective;
  seedIds?: string[];
  previousVariantSpotIds?: string[];
}): RouteOptimizationResult {
  const { profile, knowledge, objective } = input;
  const days = Math.max(1, number(profile?.days, 1));
  const dayStart = parseClock(profile.dayStart) ?? 9 * 60;
  const dayEnd = parseClock(profile.dayEnd) ?? 21 * 60;
  const all = [...(knowledge?.spots || [])];
  const required = all.filter((spot) => spot.requiredByUser);
  const requiredIds = new Set(required.map((spot) => spot.id));
  const seed = new Set(input.seedIds || []);
  const previous = new Set(input.previousVariantSpotIds || []);
  const maxPerDay = objective === "relax" ? 2 : profile?.pace === "relaxed" ? 3 : 4;
  const capacity = Math.max(required.length, days * maxPerDay);
  const ranked = [...all].sort((left, right) => {
    const priority = (spot: RouteSpot) => requiredIds.has(spot.id) ? 10_000 : seed.has(spot.id) ? 2_000 : 0;
    const diversity = (spot: RouteSpot) => previous.has(spot.id) && !requiredIds.has(spot.id) ? 14 : 0;
    return priority(right) + objectiveValue(right, objective) - diversity(right) - (priority(left) + objectiveValue(left, objective) - diversity(left));
  });
  const selected = ranked.slice(0, Math.min(ranked.length, capacity));
  for (const spot of required) if (!selected.some((candidate) => candidate.id === spot.id)) selected.unshift(spot);

  const buckets = Array.from({ length: days }, () => [] as RouteSpot[]);
  const infeasibleRequiredIds: string[] = [];
  for (const spot of selected) {
    let choice: { day: number; route: RouteSpot[]; cost: number } | null = null;
    for (let day = 0; day < days; day += 1) {
      if (buckets[day].length >= maxPerDay && !spot.requiredByUser) continue;
      const inserted = bestInsertion(buckets[day], spot, knowledge?.trafficMatrix, objective, dayStart, dayEnd);
      if (!inserted) continue;
      const cost = inserted.cost + buckets[day].length * (objective === "relax" ? 9 : 5);
      if (!choice || cost < choice.cost) choice = { day, route: inserted.route, cost };
    }
    if (choice) buckets[choice.day] = choice.route;
    else if (spot.requiredByUser) {
      const day = buckets.reduce((best, bucket, index, rows) => bucket.length < rows[best].length ? index : best, 0);
      buckets[day].push(spot);
      infeasibleRequiredIds.push(spot.id);
    }
  }

  let localSearchMoves = 0;
  const routed = buckets.map((bucket) => {
    const improved = improveRoute(bucket, knowledge?.trafficMatrix, objective, dayStart, dayEnd);
    localSearchMoves += improved.moves;
    return improved.route;
  });
  const estimatedTransitMinutes = routed.reduce((sum, bucket) => sum + simulateDay(bucket, knowledge?.trafficMatrix, objective, dayStart, dayEnd).transit, 0);
  const selectedIds = routed.flat().map((spot) => spot.id);
  const selectedIdSet = new Set(selectedIds);
  const repeated = routed.flat().filter((spot) => previous.has(spot.id) && !spot.requiredByUser).length;
  const clusterPenalty = Math.round(estimatedTransitMinutes / Math.max(1, selectedIds.length));
  const objectiveScore = Math.round(routed.flat().reduce((sum, spot) => sum + objectiveValue(spot, objective), 0) / Math.max(1, selectedIds.length) - clusterPenalty * 0.25 - repeated * 1.5);
  return {
    dayBuckets: routed,
    selectedIds,
    excluded: ranked.filter((spot) => !selectedIdSet.has(spot.id)).map((spot) => ({ spotId: spot.id, reason: `超过${objective}方案容量、时间窗不可行或边际效用较低` })),
    objectiveScore,
    diagnostics: {
      requiredCovered: required.filter((spot) => selectedIdSet.has(spot.id)).length,
      requiredTotal: required.length,
      estimatedTransitMinutes,
      clusterPenalty,
      diversityPenalty: repeated,
      localSearchMoves,
      infeasibleRequiredIds,
    },
  };
}
