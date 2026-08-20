"use client";

import type { TravelFactStatus } from "../../worker/domain/types.ts";
import type { UiPlan } from "../types.ts";

const labels: Record<TravelFactStatus, string> = { verified: "Verified", estimated: "Estimated", predicted: "Prediction", unknown: "Unknown", conflicting: "Conflicting", stale: "Stale" };

export function EvidencePanel({ plan }: { plan: UiPlan }) {
  const counts = plan.travelFacts?.reduce<Record<string, number>>((result, fact) => ({ ...result, [fact.status]: (result[fact.status] ?? 0) + 1 }), {}) ?? {};
  return <div className="react-evidence-panel">
    <div className="evidence-overview">{(["verified","estimated","predicted","unknown","conflicting","stale"] as TravelFactStatus[]).map((status) => <article key={status} data-status={status}><b>{counts[status] ?? 0}</b><span>{labels[status]}</span></article>)}</div>
    <section className="evidence-graph-summary"><div><strong>Evidence Graph</strong><span>Source → Fact → Itinerary Node</span></div><b>{plan.evidenceGraph?.sourceCount ?? 0}<small>来源</small></b><b>{plan.evidenceGraph?.factCount ?? 0}<small>事实</small></b><b>{plan.evidenceGraph?.itineraryNodeCount ?? 0}<small>节点</small></b></section>
    <div className="fact-list">{plan.travelFacts?.slice(0, 12).map((fact) => <article key={fact.id}><i data-status={fact.status}></i><div><b>{fact.subject} · {fact.field}</b><span>{fact.sourceName}</span><small>{fact.uncertaintyReason ?? fact.downstreamImpact}</small></div><em data-status={fact.status}>{labels[fact.status]}</em></article>)}</div>
  </div>;
}

