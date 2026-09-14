import type { PlannerDraft, PlannerKnowledgePack, TrafficMatrixLeg } from "./planner-v4.ts";

function validCoordinate(lat: unknown, lng: unknown): lat is number {
  return typeof lat === "number" && typeof lng === "number"
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function straightLineMeters(left: { lat: number; lng: number }, right: { lat: number; lng: number }) {
  const radians = Math.PI / 180;
  const latDelta = (right.lat - left.lat) * radians;
  const lngDelta = (right.lng - left.lng) * radians;
  const arc = Math.sin(latDelta / 2) ** 2
    + Math.cos(left.lat * radians) * Math.cos(right.lat * radians) * Math.sin(lngDelta / 2) ** 2;
  return Math.round(12_742_000 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc)));
}

function publicTransitMinutes(distanceM: number) {
  if (distanceM <= 1200) return Math.max(8, Math.round(distanceM / 75));
  const access = Math.min(12, Math.max(5, Math.round(distanceM / 2200)));
  const waiting = distanceM > 12_000 ? 8 : 6;
  const riding = Math.max(4, Math.round(distanceM * 1.12 / 430));
  const transfers = distanceM > 16_000 ? 9 : distanceM > 7_000 ? 5 : 0;
  const egress = Math.min(10, Math.max(4, Math.round(distanceM / 2800)));
  return access + waiting + riding + transfers + egress;
}

export function estimatedRoadMinutes(distanceM: number) {
  return Math.max(8, Math.round(distanceM / 260));
}

// The candidate matrix intentionally keeps only hotel, required and nearby edges.
// Fill *selected* missing edges as estimates so the compiler can reserve time;
// the final-transit stage still checks those edges with the map provider.
export function materializeSelectedSparseLegs(draft: PlannerDraft, pack: PlannerKnowledgePack): number {
  const matrix = pack.trafficMatrix;
  if (matrix?.graphPolicy !== "hotel-required-knn-lazy" || !Array.isArray(matrix.legs)) return 0;
  const spots = new Map(pack.spots.map((spot) => [spot.id, spot]));
  const known = new Set(matrix.legs.map((leg) => `${leg.fromId}->${leg.toId}`));
  const publicTransit = /公交|地铁|公共交通/.test(String(pack.profile.transport ?? ""));
  let added = 0;
  for (const variant of draft.variants) for (const day of variant.days) {
    const activities = day.activities.filter((activity) => activity.spotId)
      .sort((left, right) => left.startTime.localeCompare(right.startTime));
    for (let index = 1; index < activities.length; index += 1) {
      const fromId = activities[index - 1].spotId!;
      const toId = activities[index].spotId!;
      if (fromId === toId || known.has(`${fromId}->${toId}`) || known.has(`${toId}->${fromId}`)) continue;
      const from = spots.get(fromId);
      const to = spots.get(toId);
      if (!from || !to || !validCoordinate(from.lat, from.lng) || !validCoordinate(to.lat, to.lng)) continue;
      const distanceM = Math.max(1, Math.round(straightLineMeters(
        { lat: from.lat, lng: from.lng! }, { lat: to.lat, lng: to.lng! },
      ) * 1.25));
      const durationMin = publicTransit ? publicTransitMinutes(distanceM) : estimatedRoadMinutes(distanceM);
      const leg: TrafficMatrixLeg = {
        fromId, toId, durationMin, distanceM,
        source: publicTransit ? "相邻行程坐标距离公共交通估算（待最终地图复核）" : "相邻行程坐标距离道路估算（待最终地图复核）",
        quality: "estimated", fetchedAt: matrix.fetchedAt,
      };
      matrix.legs.push(leg);
      known.add(`${fromId}->${toId}`);
      added += 1;
    }
  }
  return added;
}
