"use client";

import type { PlanningProgress, TravelProfile, UiPlan } from "../types.ts";
import { Icon, type IconName } from "./Icon.tsx";

interface Props {
  profile: TravelProfile | null;
  progress: PlanningProgress | null;
  plans?: UiPlan[];
  onCancel?: () => void;
}

const pipeline: Array<{ label: string; detail: string; match: RegExp; icon: IconName }> = [
  { label: "锁定用户约束", detail: "必去、时间、节奏和预算", match: /约束|画像|必去|参数/, icon: "check" },
  { label: "计算空间关系", detail: "景点分区与交通可达性", match: /交通|矩阵|距离|路线/, icon: "train" },
  { label: "生成差异方案", detail: "经典、摄影与轻松三种策略", match: /方案|候选|生成|差异/, icon: "sparkles" },
  { label: "执行硬约束审计", detail: "开放时间、必去项与冲突检查", match: /校验|检查|冲突|审计|修复/, icon: "search" },
];

function stepState(index: number, items: string[], plans: UiPlan[]): "done" | "active" | "waiting" {
  if (index === 2 && plans.length >= 3) return "done";
  if (index === 3 && plans.length >= 3 && items.some((item) => /通过|最终方案|0\s*项|硬约束核验/.test(item))) return "done";
  if (items.some((item) => pipeline[index].match.test(item))) return index < 3 && items.some((item) => pipeline[index + 1]?.match.test(item)) ? "done" : "active";
  if (items.some((item) => pipeline.slice(index + 1).some((next) => next.match.test(item)))) return "done";
  return index === 0 ? "active" : "waiting";
}

export function PlanningVisualization({ profile, progress, plans = [], onCancel }: Props) {
  const items = progress?.items ?? [];
  const required = profile?.requiredAttractions ?? [];
  const completed = plans.length >= 3;
  const variants = plans.length ? plans.slice(0, 3).map((plan, index) => ({
    title: plan.title || `方案 ${index + 1}`,
    city: plan.city,
    meta: `${plan.daysPlan.length} 天 · ${plan.daysPlan.reduce((sum, day) => sum + day.items.length, 0)} 个游玩节点`,
    complete: true,
  })) : [
    { title: "经典覆盖", city: profile?.city ?? "目的地", meta: "等待路线引擎返回", complete: false },
    { title: "自然摄影", city: profile?.city ?? "目的地", meta: "等待路线引擎返回", complete: false },
    { title: "轻松避峰", city: profile?.city ?? "目的地", meta: "等待路线引擎返回", complete: false },
  ];

  return <section className="planning-visual-stage" aria-live="polite">
    <header className="planning-visual-head">
      <div><span><Icon name="sparkles"/> STAGE 3 · PLAN</span><h2>{completed ? "三套差异路线的生成过程" : "AI 正在计算三套差异路线"}</h2><p>{completed ? "以下过程来自本次任务的真实计算与校验记录。" : "所有状态来自当前规划任务；未返回的数据不会显示为已完成。"}</p></div>
      {onCancel ? <button className="task-cancel" type="button" onClick={onCancel}>取消规划</button> : null}
    </header>

    <div className="planning-context-strip">
      <span><Icon name="mapPin"/><b>{profile?.city ?? "目的地识别中"}</b></span>
      <span><Icon name="calendar"/>{profile?.days ? `${profile.days} 天` : "时长待确认"}</span>
      <span><Icon name="heart"/>{profile?.preferences?.slice(0, 3).join(" / ") || "偏好待确认"}</span>
      <span><Icon name="check"/>{required.length ? `必去：${required.join("、")}` : "未指定必去项"}</span>
    </div>

    <div className="planning-engine-grid">
      <ol className="planning-pipeline">
        {pipeline.map((step, index) => {
          const state = stepState(index, items, plans);
          return <li className={state} key={step.label}><i><Icon name={state === "done" ? "check" : step.icon}/></i><div><b>{step.label}</b><span>{step.detail}</span><small>{state === "done" ? "已完成" : state === "active" ? "计算中" : "等待上一步"}</small></div></li>;
        })}
      </ol>

      <div className="planning-route-map">
        <div className="route-map-core"><Icon name="sparkles"/><strong>多约束路线引擎</strong><span>{progress?.title ?? "正在优化路线顺序……"}</span></div>
        {required.slice(0, 4).map((name, index) => <span className={`route-node node-${index + 1}`} key={name}><Icon name="mapPin"/>{name}</span>)}
        {!required.length ? <span className="route-node node-1"><Icon name="mapPin"/>候选景点</span> : null}
      </div>

      <div className="planning-variants">
        <h3>方案并行生成</h3>
        {variants.map((variant, index) => <article className={variant.complete ? "complete" : "working"} key={`${variant.title}-${index}`}>
          <span>0{index + 1}</span><div><b>{variant.title}</b><small>{variant.city} · {variant.meta}</small></div><i><Icon name={variant.complete ? "check" : "more"}/></i>
        </article>)}
      </div>
    </div>

    <footer className="planning-live-footer">
      <div><span className="live-dot"/><b>{progress?.title ?? "正在优化路线顺序……"}</b></div>
      <div className="planning-log-list">{items.length ? items.slice(-4).map((item) => <span key={item}>{item.replaceAll("Unknown", "暂未核验")}</span>) : <span>等待路线引擎返回首个计算事件</span>}</div>
    </footer>
  </section>;
}
