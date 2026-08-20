"use client";

import { useState } from "react";
import type { UiPlan } from "../types.ts";

interface Props { plans: UiPlan[]; activeId: string; onSelect: (id: string) => void }

function variantName(id: string): string {
  return id === "relax" ? "轻松舒适型" : id === "hot" ? "热门精华型" : "错峰深度型";
}

export function ItineraryValidation({ plans, activeId, onSelect }: Props) {
  const [selectedId, setSelectedId] = useState(activeId);
  const active = plans.find((plan) => plan.id === selectedId) ?? plans[0];
  return <section className="validation-stage-react panel">
    <div className="validation-hero"><div><span className="section-code">TRAVEL COMPILER 2.0</span><h2>AI 正在生成并校验你的行程</h2><p>正在生成多套候选方案，校验约束条件，并优化行程可行性</p></div><div className="compiler-ring"><strong>{active?.compiler?.reliability ?? "—"}</strong><span>/100</span><small>行程可靠度</small></div></div>
    <div className="validation-layout react-validation-layout"><div className="validation-main"><div className="validation-candidate-grid">{plans.map((plan) => <button className={plan.id === selectedId ? "active" : ""} key={plan.id} type="button" onClick={() => setSelectedId(plan.id)}><header><div><i></i><b>{variantName(plan.id)}</b></div><em>{plan.id === selectedId ? "当前比较" : "查看"}</em></header><p>{plan.strategy}</p>{plan.daysPlan.slice(0, 2).map((day) => <span key={day.day}><strong>Day {day.day}</strong>{day.items.map((item) => item.name).join(" → ")}</span>)}<footer><small>可靠性 {plan.compiler?.reliability ?? "—"}</small><small>脆弱性 {plan.fragility?.score ?? "—"}</small></footer></button>)}</div>
      <div className="validation-bottom-grid"><section className="validation-issues"><div className="stage-card-title"><strong>发现的问题 / 自动优化建议</strong><span>{active?.compiler?.issues.length ?? 0} 项</span></div>{active?.compiler?.issues.length ? active.compiler.issues.slice(0, 4).map((issue) => <p key={issue.code}><i>!</i><span>{issue.message}</span><b>{issue.severity}</b></p>) : <p><i>✓</i><span>未发现硬约束错误</span><b>通过</b></p>}</section><section className="validation-evidence"><div className="stage-card-title"><strong>数据依据</strong><span>Evidence Graph</span></div><div className="evidence-stats"><b>{active?.evidenceGraph?.sourceCount ?? 0}<small>来源</small></b><b>{active?.evidenceGraph?.factCount ?? 0}<small>事实</small></b><b>{active?.uncertainty?.count ?? 0}<small>未知</small></b></div></section></div>
    </div><aside className="validation-side"><section className="compiler-card"><h3>Travel Compiler 行程校验</h3>{active?.compiler && Object.entries(active.compiler.checks).map(([key, status]) => <p key={key}><span>{key}</span><b>{typeof status === "boolean" ? status ? "已通过" : "需处理" : status}</b></p>)}<button type="button" onClick={() => active && onSelect(active.id)}>选择此方案并进入工作台 →</button></section><section className="validation-crowd"><h3>Minimum Verification</h3>{active?.minimumVerification?.slice(0, 3).map((item) => <p key={item.factId}><b>#{item.rank} {item.subject}</b><span>{item.field} · {item.priorityScore} 分</span></p>)}</section></aside></div>
  </section>;
}
