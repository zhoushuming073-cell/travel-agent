"use client";

import type { UiPlan } from "../types.ts";

interface Props { plan: UiPlan; now: Date; onReplan: () => void; onRefresh: () => void; lastChecked: string | null }

export function currentExecutionNode(plan: UiPlan, now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const day = plan.daysPlan.find((item) => item.date === date);
  if (!day) return null;
  const index = day.items.findIndex((item) => (item.startTime ?? "99:99") <= time && (item.endTime ?? "00:00") >= time);
  if (index < 0) return null;
  return { day, item: day.items[index], next: day.items[index + 1] ?? null, time };
}

export function ExecutionMode({ plan, now, onReplan, onRefresh, lastChecked }: Props) {
  const execution = currentExecutionNode(plan, now);
  if (!execution) return null;
  return <section className="execution-mode panel"><header><div><span className="section-code">EXECUTION MODE</span><h2>当前行程正在执行</h2></div><span><i></i> {execution.time} · {plan.city}</span></header><div className="execution-grid"><article><small>当前节点</small><strong>{execution.item.name}</strong><p>{execution.item.startTime}—{execution.item.endTime}</p></article><article><small>下一站</small><strong>{execution.next?.name ?? "今日行程即将完成"}</strong><p>{execution.next?.startTime ? `建议 ${execution.next.startTime} 前到达` : "查看完整计划"}</p></article><article><small>环境状态</small><strong>按可用工具复核</strong><p>{lastChecked ? `上次检查 ${lastChecked}` : "尚未刷新"}</p></article></div><footer><button type="button" onClick={onReplan}>修改接下来行程</button><button type="button" onClick={onRefresh}>刷新天气 / 路线 / 开放状态</button></footer></section>;
}

