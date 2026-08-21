"use client";

import { useMemo, useState } from "react";
import type { TravelProfile, UiPlan } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props { plans: UiPlan[]; profile: TravelProfile | null; activeId: string; onSelect: (id: string) => void }

const checkLabels: Record<string, string> = {
  requiredCoverage: "必选景点覆盖",
  dayCount: "旅行天数匹配",
  chronology: "每日时间顺序",
  openingConflicts: "开放时间冲突",
  routeContinuity: "路线连续性",
};

function variantName(id: string): string {
  return id === "relax" ? "轻松舒适型" : id === "hot" ? "热门精华型" : "错峰深度型";
}

function recommendedId(profile: TravelProfile | null, plans: UiPlan[]): string {
  if (profile?.pace === "relax" || profile?.pace === "slow") return plans.find((plan) => plan.id === "relax")?.id ?? plans[0]?.id;
  if (profile?.crowdSensitivity === "high" || profile?.avoid?.some((item) => /拥挤|人流/.test(item))) return plans.find((plan) => plan.id !== "hot" && plan.id !== "relax")?.id ?? plans[0]?.id;
  return [...plans].sort((a, b) => Number(b.compiler?.reliability ?? 0) - Number(a.compiler?.reliability ?? 0))[0]?.id;
}

function planStats(plan: UiPlan) {
  const counts = plan.daysPlan.map((day) => day.items.length);
  const knownCost = plan.budgetBreakdown?.knownEstimate;
  const totalDistance = plan.daysPlan.reduce((sum, day) => sum + Number(day.route?.distance ?? 0), 0);
  return {
    average: counts.length ? (counts.reduce((sum, count) => sum + count, 0) / counts.length).toFixed(1) : "—",
    range: counts.length ? `${Math.min(...counts)}—${Math.max(...counts)} 个` : "—",
    distance: totalDistance > 0 ? `${(totalDistance / 1000).toFixed(1)} km` : "暂未核验",
    cost: knownCost ? `¥${knownCost}` : "暂未核验",
  };
}

export function ItineraryValidation({ plans, profile, activeId, onSelect }: Props) {
  const recommendation = useMemo(() => recommendedId(profile, plans), [plans, profile]);
  const [selectedId, setSelectedId] = useState(activeId || recommendation);
  const active = plans.find((plan) => plan.id === selectedId) ?? plans[0];
  const stats = active ? planStats(active) : null;
  const reliability = Math.max(0, Math.min(100, Number(active?.compiler?.reliability ?? 0)));

  return <section className="validation-stage-react panel">
    <div className="validation-hero"><div><span className="section-kicker">方案选择</span><h2>已为你生成 {plans.length} 套可执行方案</h2><p>先比较路线节奏、已知花费与信息可靠度，再进入行程工作台。</p></div><div className="compiler-ring" style={{ background: `conic-gradient(#20ad7a ${reliability * 3.6}deg, #e6f1ec 0deg)` }}><span><strong>{active?.compiler?.reliability ?? "—"}</strong><small>信息可靠度</small></span></div></div>
    <div className="validation-layout react-validation-layout"><div className="validation-main">
      <div className="validation-candidate-grid">{plans.map((plan) => { const currentStats = planStats(plan); return <button className={plan.id === selectedId ? "active" : ""} key={plan.id} type="button" onClick={() => setSelectedId(plan.id)}><header><div><i></i><b>{variantName(plan.id)}</b></div>{plan.id === recommendation ? <em><Icon name="sparkles"/> AI 推荐</em> : <em>查看</em>}</header><p>{plan.strategy}</p><div className="candidate-metrics"><span><small>日均景点</small><strong>{currentStats.average}</strong></span><span><small>已知花费</small><strong>{currentStats.cost}</strong></span><span><small>路线长度</small><strong>{currentStats.distance}</strong></span></div><footer><small>可靠度 {plan.compiler?.reliability ?? "—"}</small><small>稳定性 {plan.fragility ? (plan.fragility.score <= 35 ? "较高" : plan.fragility.score <= 65 ? "一般" : "需关注") : "暂未核验"}</small></footer></button>; })}</div>
      {active && <section className="plan-comparison panel"><div><small>每日安排</small><strong>{stats?.range}</strong><span>平均 {stats?.average} 个景点</span></div><div><small>交通路线</small><strong>{stats?.distance}</strong><span>{active.daysPlan.every((day) => day.route?.quality) ? "已获取路线依据" : "部分路段待核验"}</span></div><div><small>已知花费</small><strong>{stats?.cost}</strong><span>不包含未取得的实时价格</span></div><div><small>拥挤信息</small><strong>{active.compiler?.crowdRisk === "predicted" ? "预测参考" : active.compiler?.crowdRisk === "unknown" ? "暂未核验" : active.compiler?.crowdRisk ?? "暂未核验"}</strong><span>不等同于景区实时人数</span></div></section>}
      <div className="validation-bottom-grid"><section className="validation-issues"><div className="stage-card-title"><strong>需要留意</strong><span>{active?.compiler?.issues.length ?? 0} 项</span></div>{active?.compiler?.issues.length ? active.compiler.issues.slice(0, 4).map((issue) => <p key={issue.code}><i>!</i><span>{issue.message}</span><b>{issue.severity === "error" ? "需处理" : issue.severity === "warning" ? "提醒" : "说明"}</b></p>) : <p><i>✓</i><span>没有发现阻止行程执行的硬冲突</span><b>通过</b></p>}</section><section className="validation-evidence"><div className="stage-card-title"><strong>规划依据</strong><span>可追溯信息</span></div><div className="evidence-stats"><b>{active?.evidenceGraph?.sourceCount ?? 0}<small>来源</small></b><b>{active?.evidenceGraph?.factCount ?? 0}<small>事实</small></b><b>{active?.uncertainty?.count ?? 0}<small>待核验</small></b></div></section></div>
    </div><aside className="validation-side"><section className="compiler-card"><h3>执行前检查</h3>{active?.compiler && Object.entries(active.compiler.checks).map(([key, status]) => <p key={key}><span>{checkLabels[key] ?? key}</span><b>{key === "openingConflicts" ? Number(status) === 0 ? "无冲突" : `${status} 处待处理` : status ? "已通过" : "需处理"}</b></p>)}<button type="button" onClick={() => active && onSelect(active.id)}>选择此方案 <Icon name="arrow"/></button></section><details className="validation-crowd"><summary>查看优先核验项</summary>{active?.minimumVerification?.length ? active.minimumVerification.slice(0, 3).map((item) => <p key={item.factId}><b>#{item.rank} {item.subject}</b><span>{item.action}</span></p>) : <p>当前没有额外的优先核验项。</p>}</details></aside></div>
  </section>;
}
