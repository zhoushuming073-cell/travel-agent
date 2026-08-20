import type { ChangeItem, ChangeSet, ItineraryPlan, ReplanningResult } from "./types.ts";

interface SpotPosition {
  id: string;
  name: string;
  day: number;
  index: number;
  time: string;
}

function positions(plan: ItineraryPlan): Map<string, SpotPosition> {
  const result = new Map<string, SpotPosition>();
  plan.daysPlan.forEach((day) => day.items.forEach((item, index) => result.set(item.id, {
    id: item.id,
    name: item.name,
    day: day.day,
    index,
    time: `${item.startTime ?? "?"}–${item.endTime ?? "?"}`,
  })));
  return result;
}

function item(position: SpotPosition, kind: ChangeItem["kind"], before?: string, after?: string): ChangeItem {
  return { nodeId: position.id, day: position.day, label: position.name, kind, before, after };
}

export function computeChangeSet(previous: ItineraryPlan, proposed: ItineraryPlan, requestedDays: number[] = []): ChangeSet {
  const before = positions(previous);
  const after = positions(proposed);
  const added: ChangeItem[] = [];
  const removed: ChangeItem[] = [];
  const moved: ChangeItem[] = [];
  const timeChanged: ChangeItem[] = [];
  let unchangedNodeCount = 0;
  for (const current of before.values()) {
    const next = after.get(current.id);
    if (!next) {
      removed.push(item(current, "removed", `Day ${current.day} · ${current.time}`));
      continue;
    }
    if (current.day !== next.day || current.index !== next.index) {
      moved.push(item(next, "moved", `Day ${current.day} · 第 ${current.index + 1} 站`, `Day ${next.day} · 第 ${next.index + 1} 站`));
    }
    if (current.time !== next.time) {
      timeChanged.push(item(next, "time-changed", current.time, next.time));
    }
    if (current.day === next.day && current.index === next.index && current.time === next.time) unchangedNodeCount += 1;
  }
  for (const current of after.values()) {
    if (!before.has(current.id)) added.push(item(current, "added", undefined, `Day ${current.day} · ${current.time}`));
  }
  const changedDays = new Set<number>(requestedDays);
  [...added, ...removed, ...moved, ...timeChanged].forEach((change) => changedDays.add(change.day));
  const affectedDays = [...changedDays].sort((left, right) => left - right);
  const allDays = Array.from({ length: proposed.days }, (_, index) => index + 1);
  return {
    mode: requestedDays.length ? "minimum-disruption" : "global-with-preservation-guidance",
    affectedDays,
    preservedDays: allDays.filter((day) => !affectedDays.includes(day)),
    added,
    removed,
    moved,
    timeChanged,
    unchangedNodeCount,
    changedNodeCount: added.length + removed.length + moved.length + timeChanged.length,
  };
}

export function preserveUnaffectedDays(previous: ItineraryPlan, proposed: ItineraryPlan, affectedDays: number[]): ItineraryPlan {
  if (!affectedDays.length) return proposed;
  const before = new Map(previous.daysPlan.map((day) => [day.day, day]));
  return {
    ...proposed,
    daysPlan: proposed.daysPlan.map((day) => affectedDays.includes(day.day) ? day : (before.get(day.day) ?? day)),
  };
}

export function proposeReplan(previous: ItineraryPlan, proposed: ItineraryPlan, affectedDays: number[]): ReplanningResult {
  const minimumDisruptionPlan = preserveUnaffectedDays(previous, proposed, affectedDays);
  return {
    proposedPlan: minimumDisruptionPlan,
    changeSet: computeChangeSet(previous, minimumDisruptionPlan, affectedDays),
    requiresConfirmation: true,
  };
}

