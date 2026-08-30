"use client";

import { useEffect, useState } from "react";
import type { AgentEvent, PlanningProgress, UiPlan } from "../../types.ts";
import { loadProviders, type ProviderStatusResponse } from "../../services/planningApi.ts";
import { AgentActivity } from "../AgentActivity.tsx";
import { Icon } from "../Icon.tsx";

function ServiceHealth({ status }: { status: ProviderStatusResponse | null }) {
  if (!status) return <div><h3>数据服务运行状态</h3><p><b>正在读取真实调用记录</b><span>没有记录时不会显示“正常”</span></p></div>;
  const rows = status.providers.slice(0, 6);
  return <div className="service-health"><h3>数据服务运行状态</h3>{rows.length ? rows.map((item) => { const successRate = item.totalRequests ? Math.round(Number(item.successCount || 0) / item.totalRequests * 100) : null; return <p key={item.provider}><b>{item.provider} · {item.status === "healthy" ? "正常" : item.status === "degraded" ? "限流/降级" : "不可用"}</b><span>{successRate == null ? "暂无成功率" : `成功率 ${successRate}%`} · {item.latencyMs == null ? "耗时未知" : `${item.latencyMs}ms`} · 429 {item.rateLimitedCount || 0} · 缓存 {item.cacheHits || 0}</span></p>; }) : <p><b>尚无真实调用记录</b><span>服务状态保持未知</span></p>}<p><b>运行汇总</b><span>24h 请求 {status.metrics.requests24h ?? 0} · 有效缓存 {status.metrics.cacheEntries ?? 0} · 命中 {status.metrics.cacheHits ?? 0}</span></p></div>;
}

interface Props {
  plan: UiPlan;
  progress?: PlanningProgress | null;
  events: AgentEvent[];
  versions: Array<{ id: string; version: number; summary: string; createdAt: string }>;
  onRestoreVersion: (id: string) => void;
}

export function PlanningInsights({ plan, progress, events, versions, onRestoreVersion }: Props) {
  const [providerStatus, setProviderStatus] = useState<ProviderStatusResponse | null>(null);
  useEffect(() => { let active = true; void loadProviders().then((value) => { if (active) setProviderStatus(value); }).catch(() => undefined); return () => { active = false; }; }, [plan.id]);
  return <details className="planning-insights panel"><summary><div><span className="section-kicker">规划依据</span><strong>数据处理、校验与版本记录</strong></div><small>{progress?.generatedAt ? `数据更新于 ${new Date(progress.generatedAt).toLocaleString("zh-CN")}` : "查看智能体活动和技术校验"}</small><Icon name="chevronDown"/></summary><div className="planning-insights-body">{progress?.items?.length ? <section className="planning-record"><h3>{progress.title}</h3>{progress.items.map((item) => <p key={item}>{item}</p>)}{plan.planningDecision?.degraded ? <strong className="degraded-note">透明降级：{plan.planningDecision.degradationReason}</strong> : null}</section> : null}<AgentActivity events={events}/><section className="trust-dashboard"><div><h3>关键路径</h3>{plan.criticalPath?.nodes.slice(0, 4).map((node) => <p key={node.id}><b>{node.name}</b><span>{node.reason}</span></p>)}</div><div><h3>优先核验</h3>{plan.minimumVerification?.slice(0, 4).map((item) => <p key={item.factId}><b>#{item.rank} {item.subject}</b><span>{item.action}</span></p>)}</div><div><h3>压力测试</h3>{plan.stressTest?.scenarios.slice(0, 4).map((scenario) => <p key={scenario.id}><b>{scenario.name}</b><span>{scenario.outcome} · 预计传播 {scenario.propagatedDelayMinutes} 分钟</span></p>)}</div><div><h3>版本历史</h3>{versions.length ? versions.slice().reverse().map((version) => <button key={version.id} type="button" onClick={() => onRestoreVersion(version.id)}><b>版本 {version.version} · {new Date(version.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</b><span>{version.summary || "行程已更新"}</span></button>) : <p>当前只有正在查看的方案。</p>}</div><ServiceHealth status={providerStatus}/></section></div></details>;
}
