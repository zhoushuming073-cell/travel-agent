"use client";

import { useState } from "react";
import type { AgentEvent, PlanningProgress, UiPlan } from "../types.ts";
import { Icon } from "./Icon.tsx";
import { ItineraryTimeline } from "./ItineraryTimeline.tsx";
import { DecisionPanel } from "./dashboard/DecisionPanel.tsx";
import { DiscoverPanel } from "./dashboard/DiscoverPanel.tsx";
import { PlanningInsights } from "./dashboard/PlanningInsights.tsx";
import { TripOverview } from "./dashboard/TripOverview.tsx";

interface Props {
  plan: UiPlan;
  plans: UiPlan[];
  events: AgentEvent[];
  versions: Array<{ id: string; version: number; summary: string; createdAt: string }>;
  onSelectPlan: (id: string) => void;
  onRestoreVersion: (id: string) => void;
  onOpenReplan: () => void;
  progress?: PlanningProgress | null;
}

function variantLabel(id: string): string { return id === "relax" ? "舒适版" : id === "hot" ? "精华版" : "错峰版"; }

export function ReadyDashboard({ plan, plans, events, versions, onSelectPlan, onRestoreVersion, onOpenReplan, progress }: Props) {
  const [selectedDay, setSelectedDay] = useState<number | null>(plan.daysPlan[0]?.day ?? null);
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);

  const selectSpot = (spotId: string, day: number) => {
    setSelectedDay(day);
    setSelectedSpotId(spotId);
    requestAnimationFrame(() => document.getElementById(`timeline-${spotId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  return <section className="ready-stage react-ready-stage">
    <TripOverview plan={plan} onOpenReplan={onOpenReplan}/>
    <div className="ready-grid">
      <section className="itinerary panel">
        <div className="section-heading-row"><div><span className="section-kicker">你的路线</span><h2>{plan.title}</h2><p>{plan.strategy}</p></div><div className="variant-tabs">{plans.map((item) => <button className={item.id === plan.id ? "active" : ""} key={item.id} type="button" onClick={() => { setSelectedSpotId(null); onSelectPlan(item.id); }}><b>{variantLabel(item.id)}</b><small>可靠度 {item.compiler?.reliability ?? "—"}</small></button>)}</div></div>
        <ItineraryTimeline plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectDay={setSelectedDay} onSelectSpot={selectSpot}/>
        <div className="compiler-footnote"><span><Icon name="check"/> 已完成路线与时间冲突检查</span><b>关键待核验 {plan.uncertainty?.importantCount ?? 0} 项</b></div>
      </section>
      <DecisionPanel plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectSpot={selectSpot}/>
    </div>
    <DiscoverPanel plan={plan}/>
    <PlanningInsights plan={plan} progress={progress} events={events} versions={versions} onRestoreVersion={onRestoreVersion}/>
  </section>;
}
