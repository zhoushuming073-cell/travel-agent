"use client";

import type { PlanningProgress, TravelProfile } from "../types.ts";

interface Props { request: string; profile: TravelProfile | null; progress: PlanningProgress | null }

function value(value: string | number | string[] | undefined, fallback = "识别中"): string {
  if (Array.isArray(value)) return value.length ? value.join(" / ") : fallback;
  return value === undefined || value === "" ? fallback : String(value);
}

export function RequirementProfile({ request, profile, progress }: Props) {
  const nodes = [
    ["目的地", value(profile?.city)],
    ["日期与时长", profile ? `${profile.startDate} · ${profile.days} 天` : "识别中"],
    ["同行者", profile?.partySize ? `${profile.partySize} 人` : "识别中"],
    ["旅行偏好", value(profile?.preferences)],
    ["节奏与交通", profile ? `${value(profile.pace, "适中")} · ${value(profile.transport, "待确认")}` : "识别中"],
    ["不可遗漏", value(profile?.requiredAttractions, "未指定")],
  ];
  return <div className="profile-stage-react">
    <aside className="conversation-rail panel"><div className="rail-head"><span>对话记录</span><small>原始输入保留</small></div><div className="assistant-intro">✦ 你好，我会先整理需求，再调用真实数据工具。</div><p>{request}</p></aside>
    <section className="agent-stage-panel panel">
      <div className="agent-stage-head"><div><span className="section-code">USER MODEL</span><h2>AI 正在理解你的旅行需求</h2><p>正在提取约束与偏好，构建专属用户画像</p></div><span className="live-chip"><i></i> DeepSeek 结构化</span></div>
      <div className="profile-visual react-profile-visual"><div className="profile-core"><span>AI</span><i></i></div>{nodes.map(([label,strong], index) => <div className={`profile-node profile-node-${index + 1}`} key={label}><small>{label}</small><strong>{strong}</strong></div>)}</div>
      <div className="profile-detail-grid">{[
        ["基础信息", `目的地：${value(profile?.city)}\n天数：${value(profile?.days)}\n预算：${profile?.budget ? `¥${profile.budget}` : "识别中"}`],
        ["出游偏好", `偏好：${value(profile?.preferences)}\n避开：${value(profile?.avoid, "未指定")}`],
        ["隐性推断", "只展示可由原文直接推导的约束；不会伪装长期个性学习。"],
        ["规划约束", `必选：${value(profile?.requiredAttractions, "未指定")}\n每日：${value(profile?.dayStart, "09:00")}—${value(profile?.dayEnd, "21:00")}`],
      ].map(([title, content]) => <article key={title}><b>{title}</b>{content.split("\n").map((line) => <span key={line}>{line}</span>)}</article>)}</div>
      <div className="profile-completion"><span>{profile ? "✓" : "…"}</span><div><strong>{profile ? "用户画像建立完成" : "正在建立用户画像"}</strong><small>{profile ? "工作流会自动进入资料搜集" : "等待 DeepSeek 返回结构化字段"}</small></div><b>{progress?.title ?? "正在分析您的需求……"}</b></div>
    </section>
  </div>;
}

