"use client";

import { useMemo } from "react";
import type { UiPlan } from "../../types.ts";
import { SpotImage } from "../SpotImage.tsx";

export function DiscoverPanel({ plan }: { plan: UiPlan }) {
  const uniqueSpots = useMemo(() => [...new Map(plan.daysPlan.flatMap((day) => day.items).map((spot) => [spot.id, spot])).values()], [plan.daysPlan]);
  return <section className="discover panel"><div className="section-heading-row compact"><div><span className="section-kicker">路线中的景点</span><h2>此行景点</h2><p>拥挤风险只用于时段决策；地图营业时间、预约余量和时令报道信号分别标注，不合并成“实时状态”。</p></div></div><div className="spot-grid">{uniqueSpots.slice(0, 8).map((spot) => <article className="spot-card" key={spot.id}><SpotImage name={spot.name} officialName={spot.officialName} poiId={spot.id} city={plan.city} lat={spot.lat} lng={spot.lng}/><div><span>{spot.category ?? "路线景点"}</span><strong>{spot.name}</strong><small>{spot.requiredByUser ? "用户必选 · " : ""}{spot.openingHours ? `地图常规营业时间：${spot.openingHours}` : "官方当日开放状态暂未核验"}</small><p className="spot-live-signals"><b>{spot.crowd?.score != null ? `拥挤风险 ${spot.crowd.label} · ${spot.crowd.forecastBand ? `${spot.crowd.forecastBand.low}–${spot.crowd.forecastBand.high}%` : `${spot.crowd.score}%`}` : "拥挤风险模型未返回"}</b><b>{spot.hotness?.score != null ? `近期关注信号 ${spot.hotness.score}` : "暂无近期关注信号"}</b><b>{spot.seasonality?.score != null ? `时令报道信号 ${spot.seasonality.score}` : "无可用时令报道信号"}</b></p>{spot.crowd?.confidenceLabel ? <small className="spot-crowd-confidence">模型置信度{spot.crowd.confidenceLabel} · 证据覆盖 {spot.crowd.evidenceCoverage ?? 0}% · 官方实时人数未接入</small> : <small className="spot-crowd-action">官方实时客流与指定日期预约余量：未接入</small>}{spot.crowd?.action ? <small className="spot-crowd-action">{spot.crowd.action}</small> : null}{spot.openingStatus?.alert ? <a className="spot-opening-alert" href={spot.openingStatus.sourceUrl || spot.sourceUrl || undefined} target="_blank" rel="noreferrer">开放状态可能有新公告，请核验</a> : null}</div></article>)}</div></section>;
}
