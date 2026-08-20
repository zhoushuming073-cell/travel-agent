"use client";

import type { UiPlan } from "../types.ts";
import { SpotImage } from "./SpotImage.tsx";

interface Props {
  plan: UiPlan;
  selectedDay: number;
  selectedSpotId: string | null;
  onSelectDay: (day: number) => void;
  onSelectSpot: (spotId: string, day: number) => void;
}

export function ItineraryTimeline({ plan, selectedDay, selectedSpotId, onSelectDay, onSelectSpot }: Props) {
  return <div className="react-timeline">{plan.daysPlan.map((day) => {
    const expanded = selectedDay === day.day;
    return <article className={`timeline-day${expanded ? " expanded" : ""}`} key={day.day}>
      <button className="timeline-day-head" type="button" onClick={() => onSelectDay(day.day)}><span>Day {day.day}</span><b>{day.theme ?? `第 ${day.day} 天`}</b><small>{day.date}</small><i>{expanded ? "⌃" : "⌄"}</i></button>
      {expanded && <div className="timeline-stops">{day.items.map((spot, index) => <button
        id={`timeline-${spot.id}`}
        className={`timeline-stop${selectedSpotId === spot.id ? " selected" : ""}`}
        key={spot.id}
        type="button"
        onClick={() => onSelectSpot(spot.id, day.day)}
      ><time>{spot.startTime ?? "待定"}</time><span className="timeline-line"><i>{index + 1}</i></span><SpotImage name={spot.name} city={plan.city} lat={spot.lat} lng={spot.lng}/><span className="stop-copy"><b>{spot.name}</b><small>{spot.category ?? "已核验景点"}{spot.requiredByUser ? " · 用户必选" : ""}</small><em>预计 {spot.durationMin ?? 90} 分钟</em></span><span className="stop-risk"><small>拥挤风险</small><b>{spot.crowd?.label ?? "Unknown"}</b></span><span className="stop-arrow">›</span></button>)}</div>}
    </article>;
  })}</div>;
}

