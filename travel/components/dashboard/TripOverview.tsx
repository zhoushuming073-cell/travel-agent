"use client";

import { useEffect, useState } from "react";
import type { UiPlan } from "../../types.ts";
import { ExecutionMode } from "../ExecutionMode.tsx";
import { Icon } from "../Icon.tsx";
import { BudgetPanel } from "./BudgetPanel.tsx";

function paceLabel(value?: string): string { return value === "relax" || value === "slow" ? "轻松" : value === "tight" ? "紧凑" : "适中"; }
function stabilityLabel(score?: number): string { return score === undefined ? "暂未核验" : score <= 35 ? "较稳定" : score <= 65 ? "一般" : "需关注"; }

export function TripOverview({ plan, onOpenReplan }: { plan: UiPlan; onOpenReplan: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const [shareState, setShareState] = useState("");
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!shareState) return; const timer = setTimeout(() => setShareState(""), 2500); return () => clearTimeout(timer); }, [shareState]);
  const totalDistance = plan.daysPlan.reduce((sum, day) => sum + Number(day.route?.distance ?? 0), 0);
  const routeDistance = totalDistance > 0 ? `${(totalDistance / 1000).toFixed(1)} km` : "暂未核验";
  const cost = plan.budgetBreakdown;
  const totalCost = cost?.total ? cost.total.min === cost.total.max ? `¥${cost.total.expected}` : `¥${cost.total.min}–¥${cost.total.max}` : "暂未核验";
  const share = async () => {
    const data = { title: `${plan.city} · ${plan.days}日游`, text: plan.title, url: location.href };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(location.href); setShareState("链接已复制"); }
    } catch { setShareState(""); }
  };
  return <>
    <ExecutionMode plan={plan} now={now} onReplan={onOpenReplan}/>
    <header className="ready-trip-header"><div><span className="section-kicker">已生成的旅行工作台</span><h1>{plan.city} · {plan.days}日游</h1><p>{plan.startDate || "日期待确认"} · {plan.days} 天 · {plan.budget ? `预算约 ¥${plan.budget}` : "预算未设置"}</p></div><div className="ready-trip-actions"><button type="button" onClick={() => void share()}><Icon name="arrow"/>{shareState || "分享行程"}</button></div></header>
    <section className="trip-health"><article className="health-metric"><span>{cost?.totalIsPartial ? "当前可估花销" : "预计总花销"}</span><strong>{totalCost}</strong><small>{cost ? `${cost.confidenceLabel}可信度 · ${cost.evidenceCoverage}% 费用项目依据覆盖` : "尚未生成费用模型"}</small></article><article className="health-metric"><span>路线总里程</span><strong>{routeDistance}</strong><small>按已取得的路线路段汇总</small></article><article className="health-metric"><span>行程节奏</span><strong>{paceLabel(plan.pace)}</strong><small>结合每日节点和缓冲</small></article><article className="health-metric"><span>信息可靠度</span><strong>{plan.compiler?.reliability ?? "—"}/100</strong><small>{plan.compiler?.status ?? "正在评估"}</small></article></section>
    <BudgetPanel plan={plan}/>
    <details className="ready-quality-strip"><summary>查看方案质量与待核验项</summary><div><span><b>{plan.evaluation?.overall ?? "—"}%</b>偏好匹配</span><span><b>{plan.compiler?.crowdRisk === "predicted" ? "预测" : "待核验"}</b>人流信息</span><span><b>{stabilityLabel(plan.fragility?.score)}</b>行程稳定性</span><span><b>{plan.uncertainty?.importantCount ?? 0}</b>关键待核验</span><span><b>{plan.bufferAnalysis?.minBufferMinutes ?? "—"} 分钟</b>最小缓冲</span></div></details>
  </>;
}
