import type { ItineraryPlan, PlanningFactGraph, TravelFact } from "./types.ts";

const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[\s·・—_\-（）()]/g, "");

function factVersion(fact: TravelFact) {
  const stamp = fact.fetchedAt || fact.updatedAt || "unknown";
  return `${fact.id}@${stamp}`;
}

export function buildPlanningFactGraph(plan: ItineraryPlan, facts: TravelFact[], generatedAt = new Date().toISOString()): PlanningFactGraph {
  const nodes: PlanningFactGraph["nodes"] = [];
  const edges: PlanningFactGraph["edges"] = [];
  const entities = new Map<string, { id: string; name: string; aliases: Set<string> }>();
  for (const item of plan.daysPlan.flatMap((day) => day.items)) {
    const key = normalize(item.id || item.name);
    if (!key) continue;
    const current = entities.get(key) || { id: `entity:${item.id || key}`, name: item.name, aliases: new Set<string>() };
    if (item.officialName && item.officialName !== item.name) current.aliases.add(item.officialName);
    entities.set(key, current);
  }
  for (const entity of entities.values()) {
    nodes.push({ id: entity.id, kind: "entity", label: entity.name, aliases: [...entity.aliases] });
    for (const [index, alias] of [...entity.aliases].entries()) {
      const aliasId = `${entity.id}:alias:${index}`;
      nodes.push({ id: aliasId, kind: "entity", label: alias, aliases: [entity.name] });
      edges.push({ id: `alias-edge:${aliasId}:${entity.id}`, from: aliasId, to: entity.id, relation: "alias-of" });
    }
  }

  for (const fact of facts) {
    const entity = [...entities.values()].find((candidate) => {
      const left = normalize(candidate.name);
      const right = normalize(fact.subject);
      return left && right && (left.includes(right) || right.includes(left));
    });
    const factNodeId = `fact-node:${fact.id}`;
    const derived = ["calculation", "prediction", "simulation"].includes(fact.sourceType) || fact.nature === "prediction";
    nodes.push({
      id: factNodeId,
      kind: derived ? "derived" : "fact",
      label: `${fact.subject} · ${fact.field}`,
      entityId: entity?.id,
      factId: fact.id,
      field: fact.field,
      status: fact.status,
      confidence: fact.confidence,
      validFrom: fact.observedAt || null,
      validTo: fact.expiresAt || null,
      factVersion: factVersion(fact),
      derivation: derived ? { method: fact.sourceName || fact.sourceType, inputFactIds: [] } : null,
    });
    if (entity) edges.push({ id: `edge:${entity.id}:${factNodeId}`, from: entity.id, to: factNodeId, relation: "describes" });

    const observations = fact.observations || [];
    for (const observation of observations) {
      const sourceId = `source-node:${observation.source.id}`;
      if (!nodes.some((node) => node.id === sourceId)) nodes.push({ id: sourceId, kind: "source", label: observation.source.name, confidence: observation.confidence, validFrom: observation.source.fetchedAt, validTo: fact.expiresAt || null, factVersion: `${observation.source.id}@${observation.source.fetchedAt}` });
      edges.push({ id: `edge:${factNodeId}:${sourceId}`, from: factNodeId, to: sourceId, relation: "supported-by" });
    }
    if (fact.status === "conflicting" && observations.length > 1) {
      for (let index = 1; index < observations.length; index += 1) {
        edges.push({ id: `conflict:${fact.id}:${index}`, from: `source-node:${observations[0].source.id}`, to: `source-node:${observations[index].source.id}`, relation: "conflicts-with" });
      }
    }
  }
  return { version: "1.0", generatedAt, nodes, edges };
}
