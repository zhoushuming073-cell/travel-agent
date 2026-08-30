"use client";

import { deterministicProfileHints } from "../../worker/domain/profile-extraction.ts";
import { MOTION } from "../lib/animationCatalog.ts";
import type { PlanningProgress, TravelProfile } from "../types.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { LottieMotion } from "./LottieMotion.tsx";

interface Props {
  request: string;
  profile: TravelProfile | null;
  progress: PlanningProgress | null;
  onEdit: () => void;
  onCancel?: () => void;
}

interface FactRow { label: string; value: string; icon: IconName }

function shown(input: unknown, fallback = "识别中"): string {
  if (Array.isArray(input)) return input.length ? input.join(" / ") : fallback;
  return input === undefined || input === "" || input === "Unknown" ? fallback : String(input);
}

function paceLabel(input: unknown): string {
  const labels: Record<string, string> = { slow: "轻松舒适", medium: "松紧适中", fast: "紧凑高效", relaxed: "轻松舒适" };
  return labels[String(input ?? "")] ?? shown(input, "待确认");
}

function unknownLabel(input: string): string {
  const labels: Record<string, string> = {
    budget: "总预算", budgetLevel: "预算档位", transport: "市内交通细项", hotelPreference: "住宿偏好",
    lodgingArea: "住宿区域", dayStart: "每日开始时间", dayEnd: "每日结束时间", mealPreference: "餐饮偏好",
  };
  return labels[input] ?? input;
}

function FactPanel({ title, rows, className = "" }: { title: string; rows: FactRow[]; className?: string }) {
  return <section className={`template-info-panel ${className}`.trim()}>
    <h3>{title}</h3>
    <div>{rows.map((row) => <p key={row.label}><Icon name={row.icon}/><span><small>{row.label}</small><strong>{row.value}</strong></span></p>)}</div>
  </section>;
}

export function RequirementProfile({ request, profile, progress, onEdit, onCancel }: Props) {
  const hints = deterministicProfileHints(request) as unknown as Partial<TravelProfile>;
  const effective: Partial<TravelProfile> = profile ?? hints;
  const preferences = Array.isArray(effective.preferences) ? effective.preferences : [];
  const required = Array.isArray(effective.requiredAttractions) ? effective.requiredAttractions : [];
  const avoid = Array.isArray(effective.avoid) ? effective.avoid : [];
  const unknownFields = Array.isArray(effective.unknownFields) ? effective.unknownFields.map(unknownLabel) : [];
  const profileComplete = Boolean(profile && progress?.phase !== "analysis");
  const identified = [effective.city, effective.startDate, effective.days, effective.partySize, preferences.length, required.length, effective.transport].filter(Boolean).length;
  const percentage = profileComplete ? 100 : Math.min(96, 30 + identified * 9);
  const tags = [
    effective.days ? `${effective.days}天${effective.nights ? `${effective.nights}晚` : ""}` : "行程识别中",
    effective.partySize ? `${effective.partySize}人同行` : "人数识别中",
    ...preferences.slice(0, 2),
    paceLabel(effective.pace),
    effective.transport || "交通待确认",
  ].filter((tag): tag is string => Boolean(tag));

  const inferenceRows = [
    preferences.length ? `偏好 ${preferences.slice(0, 3).join("、")} 的体验` : "兴趣偏好仍在识别",
    paceLabel(effective.pace),
    avoid.length ? `主动避开 ${avoid.join("、")}` : "拥挤敏感度待确认",
    required.length ? `优先保证 ${required.join("、")}` : "必去景点未指定",
  ];

  return <section className="template-profile-stage" aria-live="polite">
    <header className="template-profile-heading">
      <span><Icon name="sparkles"/> AI 用户画像</span>
      <h2>AI 正在理解你的旅行需求</h2>
      <p>{profileComplete ? "已将自然语言整理为本次规划所需的用户画像" : "正在构建精准的用户画像…"}</p>
      {onCancel ? <button className="task-cancel" type="button" onClick={onCancel}>取消规划</button> : null}
    </header>

    <div className="template-profile-grid">
      <div className="template-side-stack left">
        <FactPanel title="基础信息" rows={[
          { label: "目的地", value: shown(effective.city), icon: "mapPin" },
          { label: "出行日期", value: shown(effective.startDate, "日期待确认"), icon: "calendar" },
          { label: "旅行时长", value: effective.days ? `${effective.days}天${effective.nights ? `（${effective.nights}晚）` : ""}` : "识别中", icon: "clock" },
          { label: "同行人数", value: effective.partySize ? `${effective.partySize}人同行` : "识别中", icon: "users" },
        ]}/>
        <FactPanel title="出游偏好" rows={[
          { label: "兴趣方向", value: shown(preferences, "未指定"), icon: "heart" },
          { label: "行程节奏", value: paceLabel(effective.pace), icon: "clock" },
          { label: "避开事项", value: shown(avoid, "未指定"), icon: "users" },
        ]}/>
        <FactPanel title="交通偏好" className="transport" rows={[
          { label: "市内交通", value: shown(effective.transport, "待确认"), icon: "train" },
          { label: "住宿区域", value: shown(effective.lodgingArea ?? effective.hotelPreference, "待确认"), icon: "mapPin" },
        ]}/>
      </div>

      <div className="template-profile-core">
        <div className="face-scan-stage" role="img" aria-label="人脸扫描与用户画像构建动画">
          <LottieMotion src={MOTION.location} className="profile-location-motion" label="已识别目的地" loop={false} fallback={<Icon name="mapPin"/>}/>
          <LottieMotion src="/animations/face-scanning.json" className="face-scan-lottie" label="正在构建用户画像" fallback={<Icon name="sparkles"/>}/>
          <div className="template-orbit-tags" aria-label="已识别的用户画像标签">
            {tags.slice(0, 6).map((tag, index) => <span className={`tag-${index + 1}`} key={`${tag}-${index}`}>{tag}</span>)}
          </div>
        </div>
        <div className="template-analysis-progress">
          <span>{profileComplete ? "分析完成" : progress?.title ?? "正在分析您的需求"} {percentage}%</span>
          <progress max="100" value={percentage}>{percentage}%</progress>
        </div>
      </div>

      <div className="template-side-stack right">
        <section className="template-info-panel insight">
          <h3>AI 推断 <small>基于本次输入</small></h3>
          {inferenceRows.map((line) => <p key={line}><Icon name="sparkles"/><span>{line}</span></p>)}
        </section>
        <FactPanel title="规划约束" className="constraints" rows={[
          { label: "预算", value: effective.budget ? `¥${effective.budget}` : shown(effective.budgetLevel, "未指定"), icon: "wallet" },
          { label: "必须覆盖", value: shown(required, "未指定"), icon: "check" },
          { label: "每日时间", value: effective.dayStart || effective.dayEnd ? `${shown(effective.dayStart, "09:00")}—${shown(effective.dayEnd, "21:00")}` : "未指定", icon: "clock" },
          { label: "路线原则", value: "减少折返并保留休息", icon: "mapPin" },
        ]}/>
        <section className="template-info-panel potential">
          <h3>潜在需求 <small>AI 发现</small></h3>
          {(unknownFields.length ? unknownFields : ["天气与开放时间", "预约与拥挤风险", "景点间交通耗时"]).slice(0, 4).map((line) => <p key={line}><Icon name="search"/><span>{line}</span></p>)}
        </section>
      </div>
    </div>

    <footer className="template-profile-complete">
      <div className="template-radar"><strong>{identified}</strong><small>字段</small></div>
      <div><strong>{profileComplete ? "用户画像构建完成！" : "正在建立你的旅行画像"}</strong><p>{profileComplete ? "画像将用于搜集更精准的信息并生成个性化行程方案" : "明确事实与 AI 推断分开处理，不会把推断冒充成你的原意"}</p><div>{[effective.city, ...preferences.slice(0, 3), paceLabel(effective.pace), ...required.slice(0, 2)].filter(Boolean).map((tag) => <span key={String(tag)}>{String(tag)}</span>)}</div></div>
      <button className="primary-button compact" type="button" onClick={onEdit}><span>检查旅行参数</span><Icon name="arrow"/></button>
    </footer>
  </section>;
}
