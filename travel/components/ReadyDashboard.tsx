"use client";

import { useEffect, useMemo, useState } from "react";
import type { AgentEvent, PlanningProgress, UiPlan } from "../types.ts";
import { AgentActivity } from "./AgentActivity.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { ExecutionMode } from "./ExecutionMode.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { ItineraryTimeline } from "./ItineraryTimeline.tsx";
import { MapPanel } from "./MapPanel.tsx";
import { SpotImage } from "./SpotImage.tsx";
import { loadProviders, type ProviderStatusResponse } from "../services/planningApi.ts";

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

function paceLabel(value?: string): string { return value === "relax" || value === "slow" ? "轻松" : value === "tight" ? "紧凑" : "适中"; }
function weatherIcon(code?: number): IconName { return code === undefined ? "cloud" : code <= 1 ? "sun" : code <= 3 ? "cloudSun" : code >= 51 ? "rain" : "cloud"; }
function variantLabel(id: string): string { return id === "relax" ? "舒适版" : id === "hot" ? "精华版" : "错峰版"; }
function stabilityLabel(score?: number): string { return score === undefined ? "暂未核验" : score <= 35 ? "较稳定" : score <= 65 ? "一般" : "需关注"; }

function Weather({ plan, selectedDay }: { plan: UiPlan; selectedDay: number | null }) {
  const selected = plan.daysPlan.find((day) => day.day === selectedDay) ?? plan.daysPlan[0];
  return <section className="ready-weather-card"><header><b>{plan.city} · 逐日天气</b><span>超过预报范围则保持待核验</span></header><div className="weather-forecast-row">{plan.daysPlan.map((day) => { const weather = day.weather; return <article className={selected?.day === day.day ? "active" : ""} key={day.day}><small>第 {day.day} 天</small><i><Icon name={weatherIcon(weather?.weatherCode)}/></i><strong>{weather?.quality === "forecast" ? `${weather.temperatureMin ?? "—"}° / ${weather.temperatureMax ?? "—"}°` : "待核验"}</strong><span>{weather?.quality === "forecast" ? `降雨 ${weather.precipitationProbability ?? "—"}%` : "未用今日天气代替"}</span></article>; })}</div>{selected && <p className="weather-note"><b>{selected.date}</b>{selected.weather?.quality === "forecast" ? Number(selected.weather.precipitationProbability ?? 0) >= 60 ? "降雨概率较高，建议保留室内备选。" : "当前预报未触发强降雨替换规则。" : "出行日期可能超过当前预报范围，临近出发时再复核。"}</p>}</section>;
}

function Crowd({ plan }: { plan: UiPlan }) {
  const facts = plan.travelFacts?.filter((fact) => fact.field === "拥挤风险") ?? [];
  return <section className="ready-crowd-card"><header><b>到访时段拥挤风险</b><span>已直接参与排程；不是实时人数</span></header>{facts.length ? facts.slice(0, 8).map((fact) => { const confidence = Math.round(Math.max(0, Math.min(1, fact.confidence)) * 100); const value = typeof fact.value === "object" && fact.value ? fact.value as Record<string, unknown> : {}; const risk = Math.round(Number(value.score ?? value.probability ?? 0)); const label = String(value.label ?? "待核验"); const factors = Array.isArray(value.factors) ? value.factors.slice(0, 2).join("、") : "日期与时段模型"; return <div key={fact.id}><span><b>{fact.subject}</b><small>{String(value.visitDate ?? "")} {String(value.visitTime ?? "")} · {factors}</small></span><i aria-label={`预测拥挤概率 ${risk}%`}><b style={{ width: `${risk}%` }}></b></i><em>{fact.status === "predicted" ? `${label} ${risk}% · 置信度 ${confidence}%` : "暂未核验"}<small>{value.recommendedWindow ? `建议 ${String(value.recommendedWindow)}` : ""}</small></em></div>; }) : <p className="empty-evidence">当前没有足够的预测输入，未展示模拟百分比。</p>}</section>;
}

function Trends({ plan }: { plan: UiPlan }) {
  const facts = plan.travelFacts?.filter((fact) => fact.field === "趋势热度" || fact.field === "时令适配") ?? [];
  const rows = [...new Map(facts.map((fact) => [fact.subject, fact.subject])).keys()].slice(0, 6);
  return <section className="ready-trend-card"><header><b>近期关注 × 时令报道信号</b><span>均为公开网络弱信号，不代表实时客流或到访日物候</span></header>{rows.length ? rows.map((subject) => { const hot = facts.find((fact) => fact.subject === subject && fact.field === "趋势热度"); const season = facts.find((fact) => fact.subject === subject && fact.field === "时令适配"); const value = (fact?: typeof hot) => typeof fact?.value === "object" && fact.value ? fact.value as Record<string, unknown> : {}; const hotScore = hot?.status === "predicted" ? Number(value(hot).score) : null; const seasonScore = season?.status === "predicted" ? Number(value(season).score) : null; const sourceUrl = season?.sourceUrl || hot?.sourceUrl; return <article key={subject}><div><strong>{subject}</strong><small>{seasonScore != null ? String(value(season).label ?? "近期时令报道信号") : "没有可用于到访日的时令报道信号"}</small></div><span><b>{hotScore != null ? hotScore : "—"}</b><small>关注信号</small></span><span><b>{seasonScore != null ? seasonScore : "—"}</b><small>时令信号</small></span>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">来源</a> : <em>暂无来源</em>}</article>; }) : <p className="empty-evidence">当前没有可归因到路线景点的趋势或时令报道信号。</p>}</section>;
}

function Hotels({ plan }: { plan: UiPlan }) {
  const hotels = plan.hotelPlan?.candidates ?? [];
  return <section className="ready-hotel-card"><header><b>住宿候选</b><span>参考价不计入预算；指定日期成交价与余房需下单复核</span></header>{hotels.length ? hotels.slice(0, 6).map((hotel) => <article key={`${hotel.name}-${hotel.address}`}><div><strong>{hotel.name ?? "酒店候选"}</strong><span>{hotel.address ?? hotel.source ?? "地址暂未核验"}</span>{hotel.sourceUrl ? <a href={hotel.sourceUrl} target="_blank" rel="noreferrer">查看数据来源</a> : <small>来源链接暂未提供</small>}</div><b>{hotel.price ? `参考 ¥${hotel.price}` : "指定日期价格暂未取得"}<small>{hotel.priceVerifiedForDates ? "指定日期价格已核验" : hotel.price ? hotel.priceType ?? "非指定日期参考价" : "不以估算价格代替"}</small></b></article>) : <p className="empty-evidence">酒店查询没有返回可靠候选或指定日期价格，建议调整住宿区域后重试。</p>}</section>;
}

function ServiceHealth({ status }: { status: ProviderStatusResponse | null }) {
  if (!status) return <div><h3>数据服务运行状态</h3><p><b>正在读取真实调用记录</b><span>没有记录时不会显示“正常”</span></p></div>;
  const rows = status.providers.slice(0, 6);
  return <div className="service-health"><h3>数据服务运行状态</h3>{rows.length ? rows.map((item) => { const successRate = item.totalRequests ? Math.round(Number(item.successCount || 0) / item.totalRequests * 100) : null; return <p key={item.provider}><b>{item.provider} · {item.status === "healthy" ? "正常" : item.status === "degraded" ? "限流/降级" : "不可用"}</b><span>{successRate == null ? "暂无成功率" : `成功率 ${successRate}%`} · {item.latencyMs == null ? "耗时未知" : `${item.latencyMs}ms`} · 429 {item.rateLimitedCount || 0} · 缓存 {item.cacheHits || 0}</span></p>; }) : <p><b>尚无真实调用记录</b><span>服务状态保持未知</span></p>}<p><b>运行汇总</b><span>24h 请求 {status.metrics.requests24h ?? 0} · 有效缓存 {status.metrics.cacheEntries ?? 0} · 命中 {status.metrics.cacheHits ?? 0}</span></p></div>;
}

export function ReadyDashboard({ plan, plans, events, versions, onSelectPlan, onRestoreVersion, onOpenReplan, progress }: Props) {
  const [tab, setTab] = useState<"map" | "environment" | "hotel" | "evidence">("map");
  const [selectedDay, setSelectedDay] = useState<number | null>(plan.daysPlan[0]?.day ?? null);
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(plan.daysPlan[0]?.items[0]?.id ?? null);
  const [now, setNow] = useState(() => new Date());
  const [shareState, setShareState] = useState("");
  const [providerStatus, setProviderStatus] = useState<ProviderStatusResponse | null>(null);

  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!shareState) return; const timer = setTimeout(() => setShareState(""), 2500); return () => clearTimeout(timer); }, [shareState]);
  useEffect(() => { let active = true; void loadProviders().then((value) => { if (active) setProviderStatus(value); }).catch(() => undefined); return () => { active = false; }; }, [plan.id]);

  const totalDistance = useMemo(() => plan.daysPlan.reduce((sum, day) => sum + Number(day.route?.distance ?? 0), 0), [plan]);
  const routeDistance = totalDistance > 0 ? `${(totalDistance / 1000).toFixed(1)} km` : "暂未核验";
  const knownEstimate = plan.budgetBreakdown?.knownEstimate;
  const uniqueSpots = useMemo(() => [...new Map(plan.daysPlan.flatMap((day) => day.items).map((spot) => [spot.id, spot])).values()], [plan.daysPlan]);
  const selectSpot = (spotId: string, day: number) => {
    setSelectedDay(day); setSelectedSpotId(spotId);
    requestAnimationFrame(() => document.getElementById(`timeline-${spotId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  const share = async () => {
    const data = { title: `${plan.city} · ${plan.days}日游`, text: plan.title, url: location.href };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(location.href); setShareState("链接已复制"); }
    } catch { setShareState(""); }
  };

  return <section className="ready-stage react-ready-stage">
    <ExecutionMode plan={plan} now={now} onReplan={onOpenReplan}/>
    <header className="ready-trip-header"><div><span className="section-kicker">已生成的旅行工作台</span><h1>{plan.city} · {plan.days}日游</h1><p>{plan.startDate || "日期待确认"} · {plan.days} 天 · {plan.budget ? `预算约 ¥${plan.budget}` : "预算未设置"}</p></div><div className="ready-trip-actions"><button type="button" onClick={() => void share()}><Icon name="arrow"/>{shareState || "分享行程"}</button></div></header>
    <section className="trip-health"><article className="health-metric"><span>已知花费</span><strong>{knownEstimate ? `¥${knownEstimate}` : "暂未核验"}</strong><small>仅统计有依据的项目</small></article><article className="health-metric"><span>路线总里程</span><strong>{routeDistance}</strong><small>按已取得的路线路段汇总</small></article><article className="health-metric"><span>行程节奏</span><strong>{paceLabel(plan.pace)}</strong><small>结合每日节点和缓冲</small></article><article className="health-metric"><span>信息可靠度</span><strong>{plan.compiler?.reliability ?? "—"}/100</strong><small>{plan.compiler?.status ?? "正在评估"}</small></article></section>
    <details className="ready-quality-strip"><summary>查看方案质量与待核验项</summary><div><span><b>{plan.evaluation?.overall ?? "—"}%</b>偏好匹配</span><span><b>{plan.compiler?.crowdRisk === "predicted" ? "预测" : "待核验"}</b>人流信息</span><span><b>{stabilityLabel(plan.fragility?.score)}</b>行程稳定性</span><span><b>{plan.uncertainty?.importantCount ?? 0}</b>关键待核验</span><span><b>{plan.bufferAnalysis?.minBufferMinutes ?? "—"} 分钟</b>最小缓冲</span></div></details>
    <div className="ready-grid"><section className="itinerary panel"><div className="section-heading-row"><div><span className="section-kicker">你的路线</span><h2>{plan.title}</h2><p>{plan.strategy}</p></div><div className="variant-tabs">{plans.map((item) => <button className={item.id === plan.id ? "active" : ""} key={item.id} type="button" onClick={() => onSelectPlan(item.id)}><b>{variantLabel(item.id)}</b><small>可靠度 {item.compiler?.reliability ?? "—"}</small></button>)}</div></div><ItineraryTimeline plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectDay={setSelectedDay} onSelectSpot={selectSpot}/><div className="compiler-footnote"><span><Icon name="check"/> 已完成路线与时间冲突检查</span><b>关键待核验 {plan.uncertainty?.importantCount ?? 0} 项</b></div></section>
      <aside className="decision-panel panel"><div className="decision-tabs">{([['map','行程地图'],['environment','天气与人流'],['hotel','住宿'],['evidence','数据依据']] as const).map(([id,label]) => <button className={tab === id ? "active" : ""} key={id} type="button" onClick={() => setTab(id)}>{label}</button>)}</div>{tab === "map" && <MapPanel key={`${plan.id}-${selectedDay ?? "none"}`} plan={plan} selectedDay={selectedDay} selectedSpotId={selectedSpotId} onSelectSpot={selectSpot}/>} {tab === "environment" && <div className="decision-stack"><Weather plan={plan} selectedDay={selectedDay}/><Crowd plan={plan}/><Trends plan={plan}/></div>} {tab === "hotel" && <Hotels plan={plan}/>} {tab === "evidence" && <EvidencePanel plan={plan}/>}</aside></div>
    <section className="discover panel"><div className="section-heading-row compact"><div><span className="section-kicker">路线中的景点</span><h2>此行景点</h2><p>拥挤风险只用于时段决策；地图营业时间、预约余量和时令报道信号分别标注，不合并成“实时状态”。</p></div></div><div className="spot-grid">{uniqueSpots.slice(0, 8).map((spot) => <article className="spot-card" key={spot.id}><SpotImage name={spot.name} officialName={spot.officialName} poiId={spot.id} city={plan.city} lat={spot.lat} lng={spot.lng}/><div><span>{spot.category ?? "路线景点"}</span><strong>{spot.name}</strong><small>{spot.requiredByUser ? "用户必选 · " : ""}{spot.openingHours ? `地图常规营业时间：${spot.openingHours}` : "官方当日开放状态暂未核验"}</small><p className="spot-live-signals"><b>{spot.crowd?.score != null ? `拥挤风险预测 ${spot.crowd.label} ${spot.crowd.score}%` : "拥挤风险待预测"}</b><b>{spot.hotness?.score != null ? `近期关注信号 ${spot.hotness.score}` : "暂无近期关注信号"}</b><b>{spot.seasonality?.score != null ? `时令报道信号 ${spot.seasonality.score}` : "无可用时令报道信号"}</b></p><small className="spot-crowd-action">官方实时客流与指定日期预约余量：未接入</small>{spot.crowd?.action ? <small className="spot-crowd-action">{spot.crowd.action}</small> : null}{spot.openingStatus?.alert ? <a className="spot-opening-alert" href={spot.openingStatus.sourceUrl || spot.sourceUrl || undefined} target="_blank" rel="noreferrer">开放状态可能有新公告，请核验</a> : null}</div></article>)}</div></section>
    <details className="planning-insights panel"><summary><div><span className="section-kicker">规划依据</span><strong>数据处理、校验与版本记录</strong></div><small>{progress?.generatedAt ? `数据更新于 ${new Date(progress.generatedAt).toLocaleString("zh-CN")}` : "查看智能体活动和技术校验"}</small><Icon name="chevronDown"/></summary><div className="planning-insights-body">{progress?.items?.length ? <section className="planning-record"><h3>{progress.title}</h3>{progress.items.map((item) => <p key={item}>{item}</p>)}{plan.planningDecision?.degraded ? <strong className="degraded-note">透明降级：{plan.planningDecision.degradationReason}</strong> : null}</section> : null}<AgentActivity events={events}/><section className="trust-dashboard"><div><h3>关键路径</h3>{plan.criticalPath?.nodes.slice(0, 4).map((node) => <p key={node.id}><b>{node.name}</b><span>{node.reason}</span></p>)}</div><div><h3>优先核验</h3>{plan.minimumVerification?.slice(0, 4).map((item) => <p key={item.factId}><b>#{item.rank} {item.subject}</b><span>{item.action}</span></p>)}</div><div><h3>压力测试</h3>{plan.stressTest?.scenarios.slice(0, 4).map((scenario) => <p key={scenario.id}><b>{scenario.name}</b><span>{scenario.outcome} · 预计传播 {scenario.propagatedDelayMinutes} 分钟</span></p>)}</div><div><h3>版本历史</h3>{versions.length ? versions.slice().reverse().map((version) => <button key={version.id} type="button" onClick={() => onRestoreVersion(version.id)}><b>版本 {version.version} · {new Date(version.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</b><span>{version.summary || "行程已更新"}</span></button>) : <p>当前只有正在查看的方案。</p>}</div><ServiceHealth status={providerStatus}/></section></div></details>
  </section>;
}
