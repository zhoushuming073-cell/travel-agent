"use client";

import type { AgentEvent } from "../types.ts";

export function AgentActivity({ events }: { events: AgentEvent[] }) {
  return <section className="agent-activity panel"><div className="stage-card-title"><strong>AI 动态日志</strong><span>真实状态事件</span></div><div>{events.slice(-8).map((event) => <article key={event.id}><i>✓</i><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time><span><b>{event.title}</b><small>{event.detail}</small></span><em>{event.progress ?? 0}%</em></article>)}</div></section>;
}

