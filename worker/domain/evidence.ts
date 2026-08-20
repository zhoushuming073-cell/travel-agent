import type { EvidenceEdge, EvidenceGraph, EvidenceNode, ItineraryPlan, TravelFact } from "./types.ts";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "") || "node";
}

export function buildEvidenceGraph(plan: ItineraryPlan, facts: TravelFact[]): EvidenceGraph {
  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];
  const sourceIds = new Map<string, string>();
  const itineraryIds = new Map<string, string>();

  for (const day of plan.daysPlan) {
    for (const item of day.items) {
      const id = `itinerary-day-${day.day}-${slug(item.id || item.name)}`;
      itineraryIds.set(item.name, id);
      nodes.push({ id, kind: "itinerary", label: `Day ${day.day} · ${item.name}`, quality: "estimated", itineraryNodeId: item.id });
    }
    const dayId = `itinerary-day-${day.day}`;
    itineraryIds.set(`Day ${day.day} 路线`, dayId);
    itineraryIds.set(`${day.date} 天气`, dayId);
    nodes.push({ id: dayId, kind: "itinerary", label: `Day ${day.day} 路线`, quality: "estimated", itineraryNodeId: dayId });
  }

  for (const fact of facts) {
    const factNodeId = `evidence-${fact.id}`;
    nodes.push({ id: factNodeId, kind: "fact", label: `${fact.subject} · ${fact.field}`, quality: fact.status, factId: fact.id });
    const observations = fact.observations?.length
      ? fact.observations.map((item) => item.source)
      : [{ id: `source-${slug(fact.sourceName)}`, name: fact.sourceName, type: fact.sourceType, url: fact.sourceUrl, fetchedAt: fact.updatedAt, quality: fact.status }];
    for (const source of observations) {
      const key = `${source.type}|${source.name}|${source.url ?? ""}`;
      let sourceId = sourceIds.get(key);
      if (!sourceId) {
        sourceId = source.id || `source-${slug(key)}`;
        sourceIds.set(key, sourceId);
        nodes.push({ id: sourceId, kind: "source", label: source.name, quality: source.quality, url: source.url });
      }
      edges.push({ id: `edge-${sourceId}-${fact.id}`, from: sourceId, to: factNodeId, relation: fact.status === "conflicting" ? "conflicts-with" : "supports" });
    }
    const itineraryId = itineraryIds.get(fact.subject);
    if (itineraryId) edges.push({ id: `edge-${fact.id}-${itineraryId}`, from: factNodeId, to: itineraryId, relation: "informs" });
  }

  return {
    nodes,
    edges,
    sourceCount: nodes.filter((node) => node.kind === "source").length,
    factCount: facts.length,
    itineraryNodeCount: nodes.filter((node) => node.kind === "itinerary").length,
  };
}

