"use client";

import type { PendingChange } from "../types.ts";

interface Props { pending: PendingChange; onApply: () => void; onDiscard: () => void }

export function ChangePreview({ pending, onApply, onDiscard }: Props) {
  const changeSet = pending.changeSet;
  const rows = [
    ["删除", changeSet?.removed ?? []],
    ["新增", changeSet?.added ?? []],
    ["移动", changeSet?.moved ?? []],
    ["时间变化", changeSet?.timeChanged ?? []],
  ] as const;
  return <div className="change-preview-overlay" role="dialog" aria-modal="true" aria-label="调整预览"><section className="change-preview-card"><div className="dialog-head"><div><span className="section-code">CHANGE PREVIEW</span><h2>应用调整前先确认</h2><p>{pending.adjustment}</p></div><button className="dialog-close" type="button" onClick={onDiscard}>×</button></div><div className="change-preview-summary"><div><span>Reliability</span><b>{pending.before.compiler?.reliability ?? "—"} → {pending.after.compiler?.reliability ?? "—"}</b></div><div><span>Fragility</span><b>{pending.before.fragility?.score ?? "—"} → {pending.after.fragility?.score ?? "—"}</b></div><div><span>Critical Unknown</span><b>{pending.before.uncertainty?.importantCount ?? "—"} → {pending.after.uncertainty?.importantCount ?? "—"}</b></div><div><span>Stress Test Delta</span><b>{pending.before.stressTest?.resilientCount ?? "—"} → {pending.after.stressTest?.resilientCount ?? "—"}</b></div></div><div className="node-change-list">{rows.map(([label, changes]) => <section key={label}><h3>{label} <b>{changes.length}</b></h3>{changes.length ? changes.slice(0, 8).map((change) => <p key={`${label}-${change.nodeId}-${change.day}`}><span>{change.label}</span><small>{change.before ?? "—"} {change.after ? `→ ${change.after}` : ""}</small></p>) : <p className="no-change">无</p>}</section>)}</div><div className="change-scope-note"><b>最小扰动结果</b><span>保持 {changeSet?.unchangedNodeCount ?? 0} 个节点不变；受影响日：{changeSet?.affectedDays.join("、") || "未明确"}</span></div><div className="change-preview-actions"><button className="secondary-button" type="button" onClick={onDiscard}>继续使用原方案</button><button className="primary-button compact" type="button" onClick={onApply}><span>确认并保存新版本</span><b>✓</b></button></div></section></div>;
}

