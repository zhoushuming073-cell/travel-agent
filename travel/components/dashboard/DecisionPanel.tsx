"use client";

import { useState } from "react";
import type { UiPlan } from "../../types.ts";
import { EvidencePanel } from "../EvidencePanel.tsx";
import { MapPanel } from "../MapPanel.tsx";
import { CrowdPanel, TrendsPanel, WeatherPanel } from "./EnvironmentPanels.tsx";
import { HotelsPanel } from "./HotelsPanel.tsx";

export function DecisionPanel({ plan, selectedDay, selectedSpotId, onSelectSpot }: { plan: UiPlan; selectedDay: number | null; selectedSpotId: string | null; onSelectSpot: (spotId: string, day: number) => void }) {
  const [tab, setTab] = useState<"map" | "environment" | "hotel" | "evidence">("map");
  return <aside className="decision-panel panel"><div className="decision-tabs">{([['map','行程地图'],['environment','天气与人流'],['hotel','住宿'],['evidence','数据依据']] as const).map(([id,label]) => <button className={tab === id ? "active" : ""} key={id} type="button" onClick={() => setTab(id)}>{label}</button>)}</div>{tab === "map" && <MapPanel key={`${plan.id}-${selectedDay ?? "none"}`} plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectSpot={onSelectSpot}/>} {tab === "environment" && <div className="decision-stack"><WeatherPanel plan={plan} selectedDay={selectedDay}/><CrowdPanel plan={plan}/><TrendsPanel plan={plan}/></div>} {tab === "hotel" && <HotelsPanel plan={plan}/>} {tab === "evidence" && <EvidencePanel plan={plan}/>}</aside>;
}
