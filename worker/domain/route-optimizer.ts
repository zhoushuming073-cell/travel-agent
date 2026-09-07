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
    lnsMoves: number;
    fatigueScore: number;
    criticalSlackMin: number;
    infeasibleRequiredIds: string[];
  };
}

export interface FeasibilityPrecheck {
  feasible: boolean;
  requiredCount: number;
  availableMinutes: number;
  lowerBoundMinutes: number;
  violations: Array<{ spotId?: string; code: "WINDOW_TOO_SHORT" | "CAPACITY_EXCEEDED"; message: string }>;
  minimalConflictSet: string[];
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

function openingWindow(spot: RouteSpot, dayStart: number, dayEnd: number, dayIndex = 0): [number, number] {
  const windows = Array.isArray(spot.availabilityWindows) ? spot.availabilityWindows as Array<Record<string, unknown>> : [];
  const matching = windows.filter((window) => Number(window.dayIndex ?? 0) === dayIndex);
  const explicit = matching.find((window) => window.status === "closed") || matching
    .filter((window) => window.status !== "unknown")
    .sort((left, right) => number(parseClock(right.end), 0) - number(parseClock(right.start), 0) - (number(parseClock(left.end), 0) - number(parseClock(left.start), 0)))[0] || null;
  if (explicit?.status === "closed") return [dayEnd, dayStart];
  if (explicit) {
    const start = parseClock(explicit.start);
    const end = parseClock(explicit.lastAdmission) ?? parseClock(explicit.end);
    if (start !== null && end !== null && end > start) return [Math.max(dayStart, start), Math.min(dayEnd, end)];
  }
  const match = String(spot.openingHours ?? "").match(/(\d{1,2}):(\d{2})\s*[-—至]\s*(\d{1,2}):(\d{2})/);
  if (!match) return [dayStart, dayEnd];
  return [Math.max(dayStart, Number(match[1]) * 60 + Number(match[2])), Math.min(dayEnd, Number(match[3]) * 60 + Number(match[4]))];
}

function duration(spot: RouteSpot, objective: RouteObjective = "hot") {
  const range = record(spot.duration);
  const minimum = number(range.min, number(spot.recommendedDurationMin, 90) * 0.7);
  const expected = number(range.expected, spot.recommendedDurationMin ?? 90);
  const maximum = number(range.max, Math.max(expected, minimum * 1.5));
  const paced = objective === "relax" ? minimum + (maximum - minimum) * 0.65 : objective === "niche" ? expected : minimum + (expected - minimum) * 0.75;
  return clamp(Math.round(paced + number(spot.entryExitBufferMin, 0)), 35, 300);
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
  const price = Math.max(0, number(spot.ticketPrice, 0));
  const pricePenalty = Math.min(18, price / (objective === "hot" ? 120 : 70));
  if (objective === "niche") return preference * 0.30 + season * 0.25 + quality * 0.15 + completeness * 0.10 + (/(自然|摄影|独特|建筑)/.test((Array.isArray(spot.tags) ? spot.tags : []).map(String).join(" ")) ? 12 : 0) - unknownPenalty - pricePenalty;
  if (objective === "relax") return preference * 0.30 + comfort * 0.25 + completeness * 0.20 + quality * 0.10 - unknownPenalty - pricePenalty;
  return quality * 0.35 + preference * 0.25 + hotness * 0.20 + completeness * 0.10 + season * 0.10 - unknownPenalty - pricePenalty;
}

function experienceTags(spot: RouteSpot) {
  return new Set((Array.isArray(spot.experienceTags) ? spot.experienceTags : Array.isArray(spot.tags) ? spot.tags : [spot.category]).map(String).filter(Boolean));
}

function experienceSimilarity(left?: RouteSpot, right?: RouteSpot) {
  if (!left || !right) return 0;
  const a = experienceTags(left);
  const b = experienceTags(right);
  if (!a.size || !b.size) return String(left.category || "") === String(right.category || "") ? 1 : 0;
  const overlap = [...a].filter((tag) => b.has(tag)).length;
  return overlap / Math.max(1, new Set([...a, ...b]).size);
}

function selectionValue(spot: RouteSpot, objective: RouteObjective) {
  const utility = objectiveValue(spot, objective);
  const access = number(spot.accessCostMin, 15) + number(spot.entryExitBufferMin, 0);
  const density = utility / Math.max(30, duration(spot, objective) + access) * 100;
  const uncertainty = clamp(number(record(spot.scoreConfidence).overall, 0.5), 0, 1);
  const exploration = (1 - uncertainty) * (spot.requiredByUser ? 0 : 4);
  return utility * 0.75 + density * 0.25 + exploration;
}

function weatherSuitability(spot: RouteSpot, weatherDay: Record<string, unknown> | undefined) {
  const rain = clamp(number(weatherDay?.precipitationProbability, 0) / 100, 0, 1);
  if (!rain) return 1;
  if (spot.indoor === true) return Math.min(1.08, 1 + rain * 0.08);
  if (spot.indoor === false) return Math.max(0.42, 1 - rain * 0.7);
  return Math.max(0.65, 1 - rain * 0.35);
}

function simulateDay(route: RouteSpot[], matrix: TrafficMatrix | undefined, objective: RouteObjective, start: number, end: number, dayIndex = 0) {
  let cursor = start;
  let transit = 0;
  let previous: RouteSpot | undefined;
  for (const spot of route) {
    const travel = legMinutes(matrix, previous, spot, objective);
    transit += travel;
    cursor += travel;
    const [open, close] = openingWindow(spot, start, end, dayIndex);
    if (spot.timeRole === "nightscape") cursor = Math.max(cursor, 18 * 60);
    cursor = Math.max(cursor, open);
    cursor += duration(spot, objective);
    if (cursor > close || cursor > end) return { feasible: false, end: cursor, transit };
    previous = spot;
  }
  const mealReserve = cursor >= 13 * 60 + 30 ? 45 : 0;
  const dinnerReserve = cursor >= 18 * 60 + 30 ? 55 : 0;
  cursor += mealReserve + dinnerReserve;
  return { feasible: cursor <= end, end: cursor, transit };
}

function bestInsertion(route: RouteSpot[], spot: RouteSpot, matrix: TrafficMatrix | undefined, objective: RouteObjective, dayStart: number, dayEnd: number, dayIndex = 0, weatherDay?: Record<string, unknown>) {
  let best: { route: RouteSpot[]; cost: number } | null = null;
  for (let index = 0; index <= route.length; index += 1) {
    const candidate = [...route.slice(0, index), spot, ...route.slice(index)];
    const simulation = simulateDay(candidate, matrix, objective, dayStart, dayEnd, dayIndex);
    if (!simulation.feasible) continue;
    const before = route.length ? simulateDay(route, matrix, objective, dayStart, dayEnd, dayIndex).transit : 0;
    const crowdPenalty = objective === "relax"
      ? number(
          record(spot.crowdRisk).crowdImpact
            ?? record(spot.crowdRisk).crowdRiskScore
            ?? record(spot.crowdRisk).score
            ?? record(spot.crowd).score,
          50,
        ) * 0.12
      : 0;
    const riskPenalty = (Array.isArray(spot.unknown) ? spot.unknown.length : 0) * 3;
    const weatherPenalty = (1 - weatherSuitability(spot, weatherDay)) * 30;
    const neighbors = [candidate[index - 1], candidate[index + 1]];
    const switchPenalty = 4 + neighbors.reduce((sum, neighbor) => sum + (1 - experienceSimilarity(spot, neighbor)) * 2, 0);
    const repetitionPenalty = neighbors.reduce((sum, neighbor) => sum + experienceSimilarity(spot, neighbor) * 5, 0);
    const cost = simulation.transit - before + crowdPenalty + riskPenalty + weatherPenalty + switchPenalty + repetitionPenalty - selectionValue(spot, objective) * 0.18;
    if (!best || cost < best.cost) best = { route: candidate, cost };
  }
  return best;
}

function solutionCost(buckets: RouteSpot[][], matrix: TrafficMatrix | undefined, objective: RouteObjective, dayStart: number, dayEnd: number) {
  let score = 0;
  let carryFatigue = 0;
  let minimumSlack = Number.POSITIVE_INFINITY;
  for (let day = 0; day < buckets.length; day += 1) {
    const simulation = simulateDay(buckets[day], matrix, objective, dayStart, dayEnd, day);
    if (!simulation.feasible) return { cost: Number.POSITIVE_INFINITY, fatigue: 100, criticalSlack: 0 };
    const count = buckets[day].length;
    const load = clamp(simulation.transit * 0.15 + count * 8 + Math.max(0, simulation.end - 20 * 60) * 0.12, 0, 100);
    carryFatigue = clamp(carryFatigue * 0.35 + load, 0, 100);
    const utility = buckets[day].reduce((sum, spot) => sum + selectionValue(spot, objective), 0);
    const continuity = buckets[day].slice(1).reduce((sum, spot, index) => sum + experienceSimilarity(buckets[day][index], spot), 0);
    const slack = Math.max(0, dayEnd - simulation.end);
    minimumSlack = Math.min(minimumSlack, slack);
    score += simulation.transit + count * 4 + carryFatigue * (objective === "relax" ? 0.7 : 0.25) - utility * 0.12 - continuity * 3;
  }
  return { cost: score, fatigue: Math.round(carryFatigue), criticalSlack: Number.isFinite(minimumSlack) ? Math.round(minimumSlack) : dayEnd - dayStart };
}

function largeNeighborhoodImprove(
  source: RouteSpot[][],
  matrix: TrafficMatrix | undefined,
  objective: RouteObjective,
  dayStart: number,
  dayEnd: number,
  maxPerDay: number,
  weather: Array<Record<string, unknown>> = [],
) {
  let best = source.map((bucket) => [...bucket]);
  let bestScore = solutionCost(best, matrix, objective, dayStart, dayEnd).cost;
  let moves = 0;
  for (let round = 0; round < 8; round += 1) {
    const candidate = best.map((bucket) => [...bucket]);
    const removable = candidate.flatMap((bucket, day) => bucket.map((spot, index) => ({ spot, day, index })))
      .filter((item) => !item.spot.requiredByUser)
      .sort((left, right) => {
        const leftStress = (round % 3 === 0 ? -selectionValue(left.spot, objective) : number(record(left.spot.crowdRisk).crowdRiskScore, 0)) + number(left.spot.accessCostMin, 0);
        const rightStress = (round % 3 === 0 ? -selectionValue(right.spot, objective) : number(record(right.spot.crowdRisk).crowdRiskScore, 0)) + number(right.spot.accessCostMin, 0);
        return rightStress - leftStress || String(left.spot.id).localeCompare(String(right.spot.id));
      });
    const destroyCount = Math.max(1, Math.ceil(removable.length * (0.15 + (round % 3) * 0.05)));
    const removed = removable.slice(0, destroyCount).map((item) => item.spot);
    const removedIds = new Set(removed.map((spot) => spot.id));
    for (let day = 0; day < candidate.length; day += 1) candidate[day] = candidate[day].filter((spot) => !removedIds.has(spot.id));
    for (const spot of removed) {
      let insertion: { day: number; route: RouteSpot[]; cost: number } | null = null;
      for (let day = 0; day < candidate.length; day += 1) {
        if (candidate[day].length >= maxPerDay) continue;
        const result = bestInsertion(candidate[day], spot, matrix, objective, dayStart, dayEnd, day, weather[day]);
        if (result && (!insertion || result.cost < insertion.cost)) insertion = { day, route: result.route, cost: result.cost };
      }
      if (insertion) candidate[insertion.day] = insertion.route;
    }
    const candidateScore = solutionCost(candidate, matrix, objective, dayStart, dayEnd).cost;
    if (candidateScore + 0.5 < bestScore) {
      best = candidate;
      bestScore = candidateScore;
      moves += 1;
    }
  }
  return { buckets: best, moves, metrics: solutionCost(best, matrix, objective, dayStart, dayEnd) };
}

function improveRoute(route: RouteSpot[], matrix: TrafficMatrix | undefined, objective: RouteObjective, dayStart: number, dayEnd: number, dayIndex = 0) {
  let current = route;
  let moves = 0;
  let improved = true;
  while (improved && moves < 20) {
    improved = false;
    const baseline = simulateDay(current, matrix, objective, dayStart, dayEnd, dayIndex);
    for (let left = 0; left < current.length - 1 && !improved; left += 1) {
      for (let right = left + 1; right < current.length && !improved; right += 1) {
        const candidate = [...current.slice(0, left), ...current.slice(left, right + 1).reverse(), ...current.slice(right + 1)];
        const result = simulateDay(candidate, matrix, objective, dayStart, dayEnd, dayIndex);
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

function improveAcrossDays(
  inputBuckets: RouteSpot[][],
  matrix: TrafficMatrix | undefined,
  objective: RouteObjective,
  dayStart: number,
  dayEnd: number,
  maxPerDay: number,
  weather: Array<Record<string, unknown>> = [],
) {
  const buckets = inputBuckets.map((bucket) => [...bucket]);
  let moves = 0;
  const cost = (route: RouteSpot[], dayIndex: number) => {
    const simulation = simulateDay(route, matrix, objective, dayStart, dayEnd, dayIndex);
    return simulation.feasible ? simulation.transit : Number.POSITIVE_INFINITY;
  };
  let changed = true;
  while (changed && moves < 30) {
    changed = false;
    for (let from = 0; from < buckets.length && !changed; from += 1) {
      for (let index = 0; index < buckets[from].length && !changed; index += 1) {
        const spot = buckets[from][index];
        if (spot.requiredByUser) continue;
        for (let to = 0; to < buckets.length && !changed; to += 1) {
          if (to === from || buckets[to].length >= maxPerDay) continue;
          const source = buckets[from].filter((_, candidateIndex) => candidateIndex !== index);
          const insertion = bestInsertion(buckets[to], spot, matrix, objective, dayStart, dayEnd, to, weather[to]);
          if (!insertion || !simulateDay(source, matrix, objective, dayStart, dayEnd, from).feasible) continue;
          const before = cost(buckets[from], from) + cost(buckets[to], to);
          const after = cost(source, from) + cost(insertion.route, to);
          if (after + 2 < before) {
            buckets[from] = source;
            buckets[to] = insertion.route;
            moves += 1;
            changed = true;
          }
        }
      }
    }
  }
  for (let leftDay = 0; leftDay < buckets.length; leftDay += 1) {
    for (let rightDay = leftDay + 1; rightDay < buckets.length; rightDay += 1) {
      const before = cost(buckets[leftDay], leftDay) + cost(buckets[rightDay], rightDay);
      outer: for (let left = 0; left < buckets[leftDay].length; left += 1) {
        for (let right = 0; right < buckets[rightDay].length; right += 1) {
          if (buckets[leftDay][left].requiredByUser || buckets[rightDay][right].requiredByUser) continue;
          const candidateLeft = [...buckets[leftDay]];
          const candidateRight = [...buckets[rightDay]];
          [candidateLeft[left], candidateRight[right]] = [candidateRight[right], candidateLeft[left]];
          const after = cost(candidateLeft, leftDay) + cost(candidateRight, rightDay);
          if (Number.isFinite(after) && after + 2 < before) {
            buckets[leftDay] = candidateLeft;
            buckets[rightDay] = candidateRight;
            moves += 1;
            break outer;
          }
        }
      }
    }
  }
  return { buckets, moves };
}

export function precheckRouteFeasibility(input: {
  profile: { days?: unknown; dayStart?: string; dayEnd?: string };
  knowledge: { spots?: RouteSpot[]; trafficMatrix?: TrafficMatrix; weather?: Array<Record<string, unknown>> };
}): FeasibilityPrecheck {
  const days = Math.max(1, number(input.profile.days, 1));
  const dayStart = parseClock(input.profile.dayStart) ?? 9 * 60;
  const dayEnd = parseClock(input.profile.dayEnd) ?? 21 * 60;
  const required = (input.knowledge.spots || []).filter((spot) => spot.requiredByUser);
  const violations: FeasibilityPrecheck["violations"] = [];
  for (const spot of required) {
    const fitsAnyDay = Array.from({ length: days }, (_, dayIndex) => openingWindow(spot, dayStart, dayEnd, dayIndex))
      .some(([open, close]) => close - open >= duration(spot));
    if (!fitsAnyDay) {
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
  const minimalConflictSet = violations.flatMap((violation) => violation.spotId ? [`must_visit:${violation.spotId}`, `${violation.code}:${violation.spotId}`] : [violation.code]);
  return { feasible: violations.length === 0, requiredCount: required.length, availableMinutes, lowerBoundMinutes, violations, minimalConflictSet };
}

export function optimizeRouteBuckets(input: {
  profile: { days?: unknown; pace?: string; dayStart?: string; dayEnd?: string };
  knowledge: { spots?: RouteSpot[]; trafficMatrix?: TrafficMatrix; weather?: Array<Record<string, unknown>> };
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
    return priority(right) + selectionValue(right, objective) - diversity(right) - (priority(left) + selectionValue(left, objective) - diversity(left));
  });
  const selected = ranked.slice(0, Math.min(ranked.length, capacity));
  for (const spot of required) if (!selected.some((candidate) => candidate.id === spot.id)) selected.unshift(spot);

  const buckets = Array.from({ length: days }, () => [] as RouteSpot[]);
  const infeasibleRequiredIds: string[] = [];
  for (const spot of selected) {
    let choice: { day: number; route: RouteSpot[]; cost: number } | null = null;
    for (let day = 0; day < days; day += 1) {
      if (buckets[day].length >= maxPerDay && !spot.requiredByUser) continue;
      const inserted = bestInsertion(buckets[day], spot, knowledge?.trafficMatrix, objective, dayStart, dayEnd, day, knowledge.weather?.[day]);
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
  const local = buckets.map((bucket, dayIndex) => {
    const improved = improveRoute(bucket, knowledge?.trafficMatrix, objective, dayStart, dayEnd, dayIndex);
    localSearchMoves += improved.moves;
    return improved.route;
  });
  const crossDay = improveAcrossDays(local, knowledge?.trafficMatrix, objective, dayStart, dayEnd, maxPerDay, knowledge.weather);
  localSearchMoves += crossDay.moves;
  const locallyRouted = crossDay.buckets.map((bucket, dayIndex) => {
    const improved = improveRoute(bucket, knowledge?.trafficMatrix, objective, dayStart, dayEnd, dayIndex);
    localSearchMoves += improved.moves;
    return improved.route;
  });
  const lns = largeNeighborhoodImprove(locallyRouted, knowledge?.trafficMatrix, objective, dayStart, dayEnd, maxPerDay, knowledge.weather);
  const routed = lns.buckets;
  const estimatedTransitMinutes = routed.reduce((sum, bucket, dayIndex) => sum + simulateDay(bucket, knowledge?.trafficMatrix, objective, dayStart, dayEnd, dayIndex).transit, 0);
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
      lnsMoves: lns.moves,
      fatigueScore: lns.metrics.fatigue,
      criticalSlackMin: lns.metrics.criticalSlack,
      infeasibleRequiredIds,
    },
  };
}
