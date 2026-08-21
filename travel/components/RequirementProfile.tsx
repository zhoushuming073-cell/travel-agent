"use client";

import type { PlanningProgress, TravelProfile } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  request: string;
  profile: TravelProfile | null;
  progress: PlanningProgress | null;
  onEdit: () => void;
  onCancel?: () => void;
}

function value(value: string | number | string[] | undefined, fallback = "识别中"): string {
  if (Array.isArray(value)) return value.length ? value.join(" / ") : fallback;
  return value === undefined || value === "" || value === "Unknown" ? fallback : String(value);
}

export function RequirementProfile({ request, profile, progress, onEdit, onCancel }: Props) {
  const rows = [
    ["目的地", value(profile?.city), "mapPin"],
    ["日期与时长", profile ? `${value(profile.startDate, "日期待确认")} · ${profile.days} 天` : "识别中", "calendar"],
    ["同行人数", profile?.partySize ? `${profile.partySize} 人` : "识别中", "users"],
    ["旅行偏好", value(profile?.preferences, "未指定"), "heart"],
    ["节奏与交通", profile ? `${value(profile.pace, "适中")} · ${value(profile.transport, "待确认")}` : "识别中", "train"],
    ["必须安排", value(profile?.requiredAttractions, "未指定"), "check"],
  ] as const;
  return <div className="profile-stage-react">
    <aside className="conversation-rail panel"><div className="rail-head"><span>原始需求</span><small>保留原文</small></div><div className="assistant-intro"><Icon name="sparkles"/> 我会先整理需求，再调用真实数据工具。</div><p>{request}</p></aside>
    <section className="agent-stage-panel panel requirement-review">
      <div className="agent-stage-head"><div><span className="section-code">YOUR TRIP</span><h2>我理解的是</h2><p>先确认关键条件，识别结果会同步到旅行参数。</p></div><div className="profile-actions"><button className="secondary-button" type="button" onClick={onEdit}>修改参数</button>{onCancel ? <button className="task-cancel" type="button" onClick={onCancel}>取消规划</button> : null}</div></div>
      <div className="requirement-summary-grid">{rows.map(([label,strong,icon]) => <article key={label}><i><Icon name={icon}/></i><span><small>{label}</small><strong>{strong}</strong><em>{profile ? "AI 从描述中识别" : "正在识别"}</em></span></article>)}</div>
      <section className="ai-understanding"><div><Icon name="sparkles"/><strong>AI 理解</strong></div><p>{profile?.avoid?.length ? `你希望避开：${profile.avoid.join("、")}。` : "只采用原文可直接推导的限制，不猜测长期偏好。"} {profile?.dayStart || profile?.dayEnd ? `每日时间约为 ${value(profile.dayStart, "09:00")}—${value(profile.dayEnd, "21:00")}。` : ""}</p></section>
      <div className="profile-completion"><span>{profile ? "✓" : "…"}</span><div><strong>{profile ? "关键需求已整理" : "正在整理需求"}</strong><small>{profile ? "即将进入联网取证" : "等待 DeepSeek 返回结构化字段"}</small></div><b>{progress?.title ?? "正在分析您的需求……"}</b></div>
    </section>
  </div>;
}
