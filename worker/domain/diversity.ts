import type { ItineraryPlan, PlanDiversityProfile } from "./types.ts";

const setDistance = (left: Set<string>, right: Set<string>) => {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  const overlap = [...left].filter((item) => right.has(item)).length;
  return 1 - overlap / union.size;
};

function features(plan: ItineraryPlan) {
  const items = plan.daysPlan.flatMap((day) => day.items.map((item) => ({ ...item, day: day.day })));
  const extra = (item: object) => item as Record<string, unknown>;
  return {
    poi: new Set(items.map((item) => item.id)),
    category: new Set(items.map((item) => item.category || "unknown")),
    area: new Set(items.map((item) => String(extra(item).cluster || extra(item).district || extra(item).address || "unknown"))),
    time: new Set(items.map((item) => `${item.day}:${String(item.startTime || "").slice(0, 2)}`)),
    dailyCounts: plan.daysPlan.map((day) => day.items.length),
  };
}

export function buildPlanDiversityProfiles(plans: ItineraryPlan[]): Record<string, PlanDiversityProfile> {
  const output: Record<string, PlanDiversityProfile> = {};
  for (const plan of plans) {
    const current = features(plan);
    const others = plans.filter((candidate) => candidate.id !== plan.id).map(features);
    const average = (selector: (other: ReturnType<typeof features>) => number) => others.length ? others.reduce((sum, other) => sum + selector(other), 0) / others.length : 0;
    const poi = average((other) => setDistance(current.poi, other.poi));
    const category = average((other) => setDistance(current.category, other.category));
    const area = average((other) => setDistance(current.area, other.area));
    const time = average((other) => setDistance(current.time, other.time));
    const pace = average((other) => {
      const length = Math.max(current.dailyCounts.length, other.dailyCounts.length, 1);
      const difference = Array.from({ length }, (_, index) => Math.abs((current.dailyCounts[index] || 0) - (other.dailyCounts[index] || 0))).reduce((sum, value) => sum + value, 0);
      return Math.min(1, difference / Math.max(1, length * 3));
    });
    output[plan.id] = {
      version: "1.0",
      poi: Number(poi.toFixed(3)),
      category: Number(category.toFixed(3)),
      area: Number(area.toFixed(3)),
      time: Number(time.toFixed(3)),
      pace: Number(pace.toFixed(3)),
      overall: Number((poi * 0.30 + category * 0.20 + area * 0.20 + time * 0.15 + pace * 0.15).toFixed(3)),
    };
  }
  return output;
}
