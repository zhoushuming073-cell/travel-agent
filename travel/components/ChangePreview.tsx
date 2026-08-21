"use client";

import { useEffect, useRef } from "react";
import type { PendingChange } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props { pending: PendingChange; onApply: () => void; onDiscard: () => void }

function stability(score?: number): string {
  if (score === undefined) return "待评估";
  return score <= 35 ? "良好" : score <= 70 ? "一般" : "较低";
}

export function ChangePreview({ pending, onApply, onDiscard }: Props) {
  const cardRef = useRef<HTMLElement>(null);
  const changeSet = pending.changeSet;
  const rows = [["删除", changeSet?.removed ?? []], ["新增", changeSet?.added ?? []], ["移动", changeSet?.moved ?? []], ["时间变化", changeSet?.timeChanged ?? []]] as const;
  const affected = changeSet?.affectedDays ?? [];
  const unchangedDays = pending.before.daysPlan.map((day) => day.day).filter((day) => !affected.includes(day));

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => cardRef.current?.querySelector<HTMLElement>("button")?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDiscard();
      if (event.key !== "Tab" || !cardRef.current) return;
      const controls = [...cardRef.current.querySelectorAll<HTMLElement>("button,[tabindex]:not([tabindex='-1'])")].filter((item) => !item.hasAttribute("disabled"));
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onDiscard]);

  return <div className="change-preview-overlay" role="dialog" aria-modal="true" aria-labelledby="change-preview-title"><section ref={cardRef} className="change-preview-card"><div className="dialog-head"><div><span className="section-code">CHANGE PREVIEW</span><h2 id="change-preview-title">只调整你点名的部分</h2><p>{pending.adjustment}</p></div><button className="dialog-close" type="button" onClick={onDiscard} aria-label="关闭调整预览"><Icon name="close"/></button></div>
    <div className="change-scope-hero"><strong>未受影响的日期保持不变</strong><div>{unchangedDays.length ? unchangedDays.map((day) => <span key={day}><Icon name="check"/> Day {day} 不变</span>) : <span>本次调整影响全部日期</span>}</div></div>
    <div className="change-preview-summary"><div><span>可靠度</span><b>{pending.before.compiler?.reliability ?? "—"} → {pending.after.compiler?.reliability ?? "—"}</b></div><div><span>行程稳定性</span><b>{stability(pending.before.fragility?.score)} → {stability(pending.after.fragility?.score)}</b></div><div><span>待确认信息</span><b>{pending.before.uncertainty?.importantCount ?? "—"} → {pending.after.uncertainty?.importantCount ?? "—"}</b></div><div><span>抗延误情景</span><b>{pending.before.stressTest?.resilientCount ?? "—"} → {pending.after.stressTest?.resilientCount ?? "—"}</b></div></div>
    <div className="node-change-list">{rows.map(([label, changes]) => <section key={label}><h3>{label} <b>{changes.length}</b></h3>{changes.length ? changes.slice(0, 8).map((change) => <p key={`${label}-${change.nodeId}-${change.day}`}><span>{change.label}</span><small>{change.before ?? "—"} {change.after ? `→ ${change.after}` : ""}</small></p>) : <p className="no-change">无</p>}</section>)}</div>
    <div className="change-scope-note"><b>最小扰动结果</b><span>保持 {changeSet?.unchangedNodeCount ?? 0} 个节点不变；仅调整：{affected.length ? affected.map((day) => `Day ${day}`).join("、") : "未明确"}</span></div>
    <div className="change-preview-actions"><button className="secondary-button" type="button" onClick={onDiscard}>继续使用原方案</button><button className="primary-button compact" type="button" onClick={onApply}><span>确认调整</span><Icon name="check"/></button></div>
  </section></div>;
}
