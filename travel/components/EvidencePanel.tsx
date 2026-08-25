"use client";

import type { TravelFactStatus } from "../../worker/domain/types.ts";
import type { UiPlan } from "../types.ts";

const labels: Record<TravelFactStatus, string> = { verified: "Verified", estimated: "Estimated", predicted: "Prediction", unknown: "Unknown", conflicting: "Conflicting", stale: "Stale" };

export function EvidencePanel({ plan }: { plan: UiPlan }) {
  const counts = plan.travelFacts?.reduce<Record<string, number>>((result, fact) => ({ ...result, [fact.status]: (result[fact.status] ?? 0) + 1 }), {}) ?? {};
  const priority = ["开放状态提醒", "开放时间", "预约状态", "拥挤风险", "趋势热度", "时令适配", "逐日预报", "公共交通耗时"];
  const visibleFacts = [...(plan.travelFacts ?? [])].sort((left, right) => {
    const statusWeight: Record<string, number> = { conflicting: 0, stale: 1, unknown: 2, predicted: 3, estimated: 4, verified: 5 };
    const priorityOf = (field: string) => {
      const index = priority.indexOf(field);
      return index === -1 ? 99 : index;
    };
    return (statusWeight[left.status] ?? 9) - (statusWeight[right.status] ?? 9) || priorityOf(left.field) - priorityOf(right.field);
  }).slice(0, 18);
  return <div className="react-evidence-panel">
    <div className="evidence-overview">{(["verified","estimated","predicted","unknown","conflicting","stale"] as TravelFactStatus[]).map((status) => <article key={status} data-status={status}><b>{counts[status] ?? 0}</b><span>{labels[status]}</span></article>)}</div>
    <section className="evidence-graph-summary"><div><strong>Evidence Graph</strong><span>Source → Fact → Itinerary Node</span></div><b>{plan.evidenceGraph?.sourceCount ?? 0}<small>来源</small></b><b>{plan.evidenceGraph?.factCount ?? 0}<small>事实</small></b><b>{plan.evidenceGraph?.itineraryNodeCount ?? 0}<small>节点</small></b></section>
    <div className="fact-list">{visibleFacts.map((fact) => <article key={fact.id}><i data-status={fact.status}></i><div><b>{fact.subject} · {fact.field}</b><span>{fact.sourceName}</span><small>{fact.uncertaintyReason ?? fact.downstreamImpact}</small>{fact.sourceUrl ? <a href={fact.sourceUrl} target="_blank" rel="noreferrer">打开来源</a> : null}</div><em data-status={fact.status}>{labels[fact.status]}</em></article>)}</div>
  </div>;
}
