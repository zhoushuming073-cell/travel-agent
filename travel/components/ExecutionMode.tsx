"use client";

import type { UiPlan } from "../types.ts";

interface Props { plan: UiPlan; now: Date; onReplan: () => void }

export function currentExecutionNode(plan: UiPlan, now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const day = plan.daysPlan.find((item) => item.date === date);
  if (!day) return null;
  const index = day.items.findIndex((item) => (item.startTime ?? "99:99") <= time && (item.endTime ?? "00:00") >= time);
  if (index < 0) return null;
  return { day, item: day.items[index], next: day.items[index + 1] ?? null, time };
}

export function ExecutionMode({ plan, now, onReplan }: Props) {
  const execution = currentExecutionNode(plan, now);
  if (!execution) return null;
  return <section className="execution-mode panel"><header><div><span className="section-kicker">行程执行中</span><h2>现在：{execution.item.name}</h2></div><span><i></i> {execution.time} · {plan.city}</span></header><div className="execution-grid"><article><small>当前节点</small><strong>{execution.item.name}</strong><p>{execution.item.startTime}—{execution.item.endTime}</p></article><article><small>下一站</small><strong>{execution.next?.name ?? "今日行程即将完成"}</strong><p>{execution.next?.startTime ? `建议 ${execution.next.startTime} 前到达` : "查看完整计划"}</p></article><article><small>页面内执行监控</small><strong>天气、开放公告与下一段交通</strong><p>本页面保持打开时每 5 分钟检查；关闭页面后不会在后台继续运行</p></article></div><footer><button type="button" onClick={onReplan}>手动调整接下来的行程</button></footer></section>;
}
