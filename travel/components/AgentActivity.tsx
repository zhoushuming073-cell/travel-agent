"use client";

import type { AgentEvent } from "../types.ts";

export function AgentActivity({ events }: { events: AgentEvent[] }) {
  const visible = events.slice(-8);
  return <section className="agent-activity panel"><div className="stage-card-title"><strong>规划记录</strong><span>真实状态事件</span></div><div>{visible.map((event, index) => {
    const ongoing = index === visible.length - 1 && Number(event.progress ?? 0) < 100;
    return <article className={ongoing ? "working" : "done"} key={event.id}><i>{ongoing ? "●" : "✓"}</i><time>{new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time><span><b>{event.title}</b><small>{event.detail?.replaceAll("Unknown", "暂未核验")}</small></span><em>{ongoing ? "进行中" : "已完成"}</em></article>;
  })}</div></section>;
}
