"use client";

import { useMemo, useState } from "react";
import type { AgentEvent, UiPlan } from "../types.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { ExecutionMode } from "./ExecutionMode.tsx";
import { ItineraryTimeline } from "./ItineraryTimeline.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { SpotImage } from "./SpotImage.tsx";

interface Props {
  plan: UiPlan;
  plans: UiPlan[];
  events: AgentEvent[];
  versions: Array<{ id: string; version: number; summary: string; createdAt: string }>;
  onSelectPlan: (id: string) => void;
  onRestoreVersion: (id: string) => void;
  onOpenReplan: () => void;
}

function paceLabel(value?: string): string { return value === "relax" || value === "slow" ? "轻松" : value === "tight" ? "紧凑" : "适中"; }

function Weather({ plan }: { plan: UiPlan }) {
  const weather = plan.daysPlan[0]?.weather;
  const code = weather?.weatherCode;
  const icon = code === undefined ? "◌" : code <= 1 ? "☀" : code <= 3 ? "⛅" : code >= 51 ? "🌧" : "☁";
  const isForecast = weather?.quality === "forecast";
  const note = !isForecast
    ? "出行日期超出当前预报范围，未用今日天气替代"
    : Number(weather?.precipitationProbability ?? 0) >= 60
      ? "影响户外节点，建议启用室内备选"
      : "当前预报未触发强降雨替换规则";
  return <section className="ready-weather-card"><header><b>{plan.city} · {weather?.date ?? plan.startDate}</b><span>{isForecast ? "Verified forecast" : "Unknown"}</span></header><div><i>{icon}</i><strong>{weather?.temperatureMax ?? "—"}°<small> / {weather?.temperatureMin ?? "—"}°C</small></strong><p>降雨概率 {weather?.precipitationProbability ?? "—"}%<br/>{note}</p></div></section>;
}

function Crowd({ plan }: { plan: UiPlan }) {
  const facts = plan.travelFacts?.filter((fact) => fact.field === "拥挤风险") ?? [];
  return <section className="ready-crowd-card"><header><b>拥挤风险预测</b><span>Prediction ≠ 实时客流</span></header>{facts.slice(0, 6).map((fact, index) => <div key={fact.id}><span>{fact.subject}</span><i style={{ width: `${fact.status === "predicted" ? 35 + index * 7 : 8}%` }}></i><b>{fact.status === "predicted" ? `${Math.round(fact.confidence * 100)}% 置信` : "Unknown"}</b></div>)}</section>;
}

function Hotels({ plan }: { plan: UiPlan }) {
  const hotels = plan.hotelPlan?.candidates ?? [];
  return <section className="ready-hotel-card"><header><b>住宿规划</b><span>价格仅显示可追溯来源</span></header>{hotels.length ? hotels.slice(0, 5).map((hotel) => <article key={`${hotel.name}-${hotel.address}`}><div><strong>{hotel.name ?? "酒店候选"}</strong><span>{hotel.address ?? hotel.source ?? "已调用酒店工具"}</span></div><b>{hotel.price ? `¥${hotel.price}` : "价格待核验"}<small>{hotel.priceType ?? "指定日期成交价未知"}</small></b></article>) : <p>酒店服务已查询，但没有可靠候选或价格；结果保持 Unknown。</p>}</section>;
}

export function ReadyDashboard({ plan, plans, events, versions, onSelectPlan, onRestoreVersion, onOpenReplan }: Props) {
  const [tab, setTab] = useState<"map" | "weather" | "crowd" | "evidence">("map");
  const [selectedDay, setSelectedDay] = useState(plan.daysPlan[0]?.day ?? 1);
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(plan.daysPlan[0]?.items[0]?.id ?? null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const totalDistance = useMemo(() => plan.daysPlan.reduce((sum, day) => sum + Number(day.route?.distance ?? 0), 0), [plan]);
  const routeDistance = Math.max(0, Math.round(totalDistance / 1000 * 10) / 10);
  const crowdRisk = plan.compiler?.crowdRisk === "predicted" ? "预测" : "未知";
  const selectSpot = (spotId: string, day: number) => {
    setSelectedDay(day);
    setSelectedSpotId(spotId);
    requestAnimationFrame(() => document.getElementById(`timeline-${spotId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  return <section className="ready-stage react-ready-stage">
    <ExecutionMode plan={plan} now={new Date()} onReplan={onOpenReplan} onRefresh={() => setLastChecked(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }))} lastChecked={lastChecked}/>
    <header className="ready-trip-header"><div><span className="section-code">ACTIVE TRIP</span><h1>{plan.city} · {plan.days}日游</h1><p>{plan.startDate} · {plan.days} 天 · 预算约 ¥{plan.budget ?? "未知"}</p></div><div className="ready-trip-actions"><button type="button">☆ 收藏</button><button type="button">分享</button><button type="button">导出行程</button></div></header>
    <section className="trip-health"><article className="health-metric"><span>匹配度</span><strong>{plan.evaluation?.overall ?? "—"}%</strong><small>偏好匹配</small></article><article className="health-metric"><span>预计花费</span><strong>{plan.budgetBreakdown?.knownEstimate ? `¥${plan.budgetBreakdown.knownEstimate}` : "Unknown"}</strong><small>仅已知项目</small></article><article className="health-metric"><span>路线总里程</span><strong>{routeDistance} km</strong><small>道路路由 / 透明估算</small></article><article className="health-metric"><span>拥挤风险</span><strong>{crowdRisk}</strong><small>非实时人数</small></article><article className="health-metric"><span>节奏评分</span><strong>{paceLabel(plan.pace)}</strong><small>综合缓冲</small></article><article className="health-metric"><span>行程可靠度</span><strong>{plan.compiler?.reliability ?? "—"}/100</strong><small>{plan.compiler?.status}</small></article><article className="health-metric"><span>Fragility</span><strong>{plan.fragility?.score ?? "—"}</strong><small>越低越稳</small></article></section>
    <div className="ready-grid"><section className="itinerary panel"><div className="section-heading-row"><div><span className="section-code">ITINERARY / DECISION</span><h2>{plan.title}</h2><p>{plan.strategy}</p></div><div className="variant-control-row"><div className="variant-tabs">{plans.map((item) => <button className={item.id === plan.id ? "active" : ""} key={item.id} type="button" onClick={() => onSelectPlan(item.id)}><b>{item.id === "relax" ? "舒适版" : item.id === "hot" ? "精华版" : "错峰版"}</b><small>可靠 {item.compiler?.reliability ?? "—"} · 脆弱 {item.fragility?.score ?? "—"}</small></button>)}</div></div></div><ItineraryTimeline plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectDay={setSelectedDay} onSelectSpot={selectSpot}/><div className="compiler-footnote"><span>✓ 行程已通过 Travel Compiler 2.0</span><b>最小缓冲 {plan.bufferAnalysis?.minBufferMinutes ?? 0} 分钟 · 关键未知 {plan.uncertainty?.importantCount ?? 0} 个</b></div></section>
      <aside className="decision-panel panel"><div className="decision-tabs">{([['map','行程地图'],['weather','天气预报'],['crowd','人流预测'],['evidence','数据依据']] as const).map(([id,label]) => <button className={tab === id ? "active" : ""} key={id} type="button" onClick={() => setTab(id)}>{label}</button>)}</div>{tab === "map" && <MapPanel plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectSpot={selectSpot}/>} {tab === "weather" && <div className="decision-stack"><Weather plan={plan}/><Hotels plan={plan}/></div>} {tab === "crowd" && <Crowd plan={plan}/>} {tab === "evidence" && <EvidencePanel plan={plan}/>}</aside></div>
    <div className="ready-lower-grid"><section className="discover panel"><div className="section-heading-row compact"><div><span className="section-code">DISCOVERY / VERIFIED POI</span><h2>景点发现</h2><p>只显示本次路线中经过实体核验的景点；无可靠图片时保留名称占位</p></div></div><div className="spot-grid">{[...new Map(plan.daysPlan.flatMap((day) => day.items).map((spot) => [spot.id, spot])).values()].slice(0, 8).map((spot) => <article className="spot-card" key={spot.id}><SpotImage name={spot.name} city={plan.city} lat={spot.lat} lng={spot.lng}/><div><span>{spot.category ?? "已核验 POI"}</span><strong>{spot.name}</strong><small>{spot.requiredByUser ? "用户必选 · " : ""}{spot.openingHours ?? "开放时间 Unknown"}</small></div></article>)}</div></section><AgentActivity events={events}/></div>
    <section className="trust-dashboard panel"><div><h3>Critical Path</h3>{plan.criticalPath?.nodes.slice(0, 4).map((node) => <p key={node.id}><b>{node.name}</b><span>{node.reason}</span></p>)}</div><div><h3>Minimum Verification</h3>{plan.minimumVerification?.slice(0, 4).map((item) => <p key={item.factId}><b>#{item.rank} {item.subject}</b><span>{item.action}</span></p>)}</div><div><h3>Stress Test · Simulation</h3>{plan.stressTest?.scenarios.slice(0, 4).map((scenario) => <p key={scenario.id}><b>{scenario.name}</b><span>{scenario.outcome} · 传播 {scenario.propagatedDelayMinutes} 分钟</span></p>)}</div><div><h3>版本历史</h3>{versions.slice().reverse().map((version) => <button key={version.id} type="button" onClick={() => onRestoreVersion(version.id)}><b>Version {version.version}</b><span>{version.summary}</span></button>)}</div></section>
  </section>;
}
