export type RouteObjective = "hot" | "niche" | "relax";

interface RouteSpot extends Record<string, unknown> {
  id: string;
  requiredByUser?: boolean;
  timeRole?: string;
}

interface RouteLeg {
  fromId?: string;
  toId?: string;
  durationMin?: unknown;
}

interface TrafficMatrix {
  legs?: RouteLeg[];
}

export interface RouteOptimizationResult {
  dayBuckets: RouteSpot[][];
  selectedIds: string[];
  excluded: Array<{ spotId: string; reason: string }>;
  objectiveScore: number;
  diagnostics: { requiredCovered: number; requiredTotal: number; estimatedTransitMinutes: number; clusterPenalty: number; diversityPenalty: number };
}

const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

function legMinutes(matrix: TrafficMatrix | undefined, left: RouteSpot | undefined, right: RouteSpot | undefined) {
  if (!left || !right) return 0;
  const leg = (matrix?.legs || []).find((item) => (item.fromId === left.id && item.toId === right.id) || (item.fromId === right.id && item.toId === left.id));
  if (leg) return Math.max(1, number(leg.durationMin, 25));
  const lat1 = number(left.lat), lng1 = number(left.lng), lat2 = number(right.lat), lng2 = number(right.lng);
  if (!lat1 || !lng1 || !lat2 || !lng2) return 35;
  const x = (lng2 - lng1) * Math.cos((lat1 + lat2) * Math.PI / 360);
  const y = lat2 - lat1;
  return Math.max(8, Math.round(Math.sqrt(x * x + y * y) * 111 * 3.2));
}

function objectiveValue(spot: RouteSpot, objective: RouteObjective) {
  const preference = number(spot.plannerScore, 50);
  const quality = number(record(spot.scoreBreakdown).poiQuality, 60);
  const completeness = number(record(spot.scoreBreakdown).dataCompleteness, 45);
  const season = number(record(spot.seasonFit).score, 45);
  const hotness = number(record(spot.hotness).score, 40);
  const crowd = number(record(spot.crowdRisk).score ?? record(spot.crowd).score, 55);
  const unknownPenalty = (Array.isArray(spot.unknown) ? spot.unknown : []).length * 2.5;
  if (objective === "niche") return preference * 0.34 + season * 0.31 + quality * 0.14 + completeness * 0.11 + (/(自然|摄影)/.test((Array.isArray(spot.tags) ? spot.tags : []).map(String).join(" ")) ? 14 : 0) - unknownPenalty;
  if (objective === "relax") return preference * 0.28 + (100 - crowd) * 0.32 + completeness * 0.18 + quality * 0.12 - unknownPenalty;
  return preference * 0.27 + hotness * 0.3 + quality * 0.2 + completeness * 0.13 + season * 0.1 - unknownPenalty;
}

function routeDay(spots: RouteSpot[], matrix: TrafficMatrix | undefined) {
  if (spots.length < 2) return spots;
  const start = [...spots].sort((left, right) => Number(Boolean(right.requiredByUser)) - Number(Boolean(left.requiredByUser)) || objectiveValue(right, "hot") - objectiveValue(left, "hot"))[0];
  const remaining = spots.filter((spot) => spot.id !== start.id);
  const route = [start];
  while (remaining.length) {
    const current = route[route.length - 1];
    remaining.sort((left, right) => legMinutes(matrix, current, left) - legMinutes(matrix, current, right));
    const next = remaining.shift();
    if (next) route.push(next);
  }
  const nightIndex = route.findIndex((spot) => spot.timeRole === "nightscape");
  if (nightIndex >= 0 && nightIndex !== route.length - 1) route.push(route.splice(nightIndex, 1)[0]);
  return route;
}

export function optimizeRouteBuckets(input: {
  profile: { days?: unknown; pace?: string };
  knowledge: { spots?: RouteSpot[]; trafficMatrix?: TrafficMatrix };
  objective: RouteObjective;
  seedIds?: string[];
  previousVariantSpotIds?: string[];
}): RouteOptimizationResult {
  const { profile, knowledge, objective } = input;
  const days = Math.max(1, number(profile?.days, 1));
  const all = [...(knowledge?.spots || [])];
  const required = all.filter((spot) => spot.requiredByUser);
  const requiredIds = new Set(required.map((spot) => spot.id));
  const seed = new Set(input.seedIds || []);
  const previous = new Set(input.previousVariantSpotIds || []);
  const maxPerDay = objective === "relax" ? 2 : profile?.pace === "relaxed" ? 3 : 4;
  const capacity = Math.max(required.length, days * maxPerDay);
  const ranked = [...all].sort((left, right) => {
    const priority = (spot: RouteSpot) => requiredIds.has(spot.id) ? 10_000 : seed.has(spot.id) ? 2_000 : 0;
    const diversity = (spot: RouteSpot) => previous.has(spot.id) && !requiredIds.has(spot.id) ? 11 : 0;
    return priority(right) + objectiveValue(right, objective) - diversity(right) - (priority(left) + objectiveValue(left, objective) - diversity(left));
  });
  const selected = ranked.slice(0, Math.min(ranked.length, capacity));
  for (const spot of required) if (!selected.some((candidate) => candidate.id === spot.id)) selected.unshift(spot);

  const buckets = Array.from({ length: days }, () => [] as RouteSpot[]);
  const load = Array.from({ length: days }, () => 0);
  for (const spot of selected) {
    let bestDay = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let day = 0; day < days; day += 1) {
      if (buckets[day].length >= maxPerDay && !spot.requiredByUser) continue;
      const proximity = buckets[day].length ? Math.min(...buckets[day].map((other) => legMinutes(knowledge?.trafficMatrix, spot, other))) : 18;
      const balance = load[day] * (objective === "relax" ? 18 : 11);
      const cost = proximity + balance;
      if (cost < bestCost) { bestCost = cost; bestDay = day; }
    }
    buckets[bestDay].push(spot);
    load[bestDay] += 1;
  }
  const routed = buckets.map((bucket) => routeDay(bucket, knowledge?.trafficMatrix));
  const estimatedTransitMinutes = routed.reduce((sum, bucket) => sum + bucket.slice(1).reduce((daySum, spot, index) => daySum + legMinutes(knowledge?.trafficMatrix, bucket[index], spot), 0), 0);
  const repeated = selected.filter((spot) => previous.has(spot.id) && !spot.requiredByUser).length;
  const clusterPenalty = Math.round(estimatedTransitMinutes / Math.max(1, selected.length));
  const objectiveScore = Math.round(selected.reduce((sum, spot) => sum + objectiveValue(spot, objective), 0) / Math.max(1, selected.length) - clusterPenalty * 0.25 - repeated * 1.5);
  return {
    dayBuckets: routed,
    selectedIds: selected.map((spot) => spot.id),
    excluded: ranked.slice(selected.length).map((spot) => ({ spotId: spot.id, reason: `超过${objective}方案容量或边际效用较低` })),
    objectiveScore,
    diagnostics: { requiredCovered: required.filter((spot) => selected.some((candidate) => candidate.id === spot.id)).length, requiredTotal: required.length, estimatedTransitMinutes, clusterPenalty, diversityPenalty: repeated },
  };
}
