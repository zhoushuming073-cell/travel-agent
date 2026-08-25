"use client";

import type { TravelFormState } from "../types.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { TripParameterPanel } from "./TripParameterPanel.tsx";

interface Props {
  value: string;
  form: TravelFormState;
  busy: boolean;
  onChange: (value: string) => void;
  onFormChange: (form: TravelFormState) => void;
  onSubmit: () => void;
  parametersOpen: boolean;
  onToggleParameters: () => void;
}

const examples = [
  ["great-wall", "带父母去北京玩4天", "想轻松一些，预算3000左右", "带父母去北京玩4天，想看长城和历史文化，行程轻松一些，预算3000元左右。"],
  ["culture-city", "国庆去成都5天", "喜欢美食和人文，尽量避峰", "国庆去成都玩5天，喜欢美食和人文，希望避开人多的地方。"],
  ["skyline", "带孩子去上海玩3天", "需要合理规划路线和时间", "带孩子去上海迪士尼玩3天，需要合理规划路线和时间。"],
];

export function EmptyTripHero({ value, form, busy, onChange, onFormChange, onSubmit, parametersOpen, onToggleParameters }: Props) {
  const preference = form.preferences.join("、") || form.style || "未设置";
  const quickParams: Array<[IconName, string, string, string]> = [
    ["mapPin", "目的地", form.city || "未设置", form.city ? "已补充" : "等待文字识别"],
    ["calendar", "日期", form.startDate || "未设置", form.startDate ? "已补充" : "等待文字识别"],
    ["clock", "天数", `${form.days}天`, "系统默认"],
    ["users", "人数", `${form.partySize}人`, "系统默认"],
  ];
  return <section className="empty-stage react-empty-stage" aria-labelledby="hero-title">
    <div className="empty-copy"><h1 id="hero-title">智能旅游助手</h1><p>从一句想法，到一份 <strong>真正能出发的行程</strong></p><div className="hero-capabilities"><span><Icon name="search"/>联网查找真实景点</span><span><Icon name="check"/>标明信息可信度</span><span><Icon name="sparkles"/>生成三套差异路线</span><span><Icon name="mapPin"/>检查时间与交通</span></div></div>
    <div className="empty-layout">
      <div className="prompt-studio"><div className="query-card">
        <div className="query-input-wrap"><div className="query-content"><label htmlFor="travel-request">描述你的旅行想法…</label><textarea id="travel-request" rows={5} value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如：2026年10月去杭州玩4天，两个人，喜欢自然和摄影，必须去西湖和灵隐寺，希望不要太赶。"/><div className="query-helper"><span>日期、人数、必选项与时间限制会作为硬约束</span><button type="button" onClick={onToggleParameters}>{parametersOpen ? "收起参数" : "补充参数"}</button></div></div></div>
        <button className="primary-button" type="button" onClick={onSubmit} disabled={busy || !value.trim()}><span>{busy ? "智能体正在工作" : "开始规划"}</span><Icon name={busy ? "sparkles" : "arrow"}/></button>
      </div></div>
      <div className="city-illustration" aria-hidden="true"><img className="jiangnan-hero-art" src="/travel/assets/jiangnan-hero-v1.png" alt=""/></div>
    </div>
    <div className="quick-param-grid" aria-label="快捷旅行参数">{quickParams.map(([icon,label,strong,source]) => <button type="button" onClick={onToggleParameters} aria-expanded={parametersOpen} key={label}><i><Icon name={icon}/></i><span>{label}<strong>{strong}</strong><small>{source}</small></span></button>)}<button className={`more-params${parametersOpen ? " active" : ""}`} type="button" onClick={onToggleParameters} aria-expanded={parametersOpen}><i><Icon name="settings"/></i><span>更多参数<strong>{preference} · {form.budget ? `¥${form.budget}` : "预算未设置"}</strong><small>偏好、预算、交通与住宿</small></span><Icon name={parametersOpen ? "chevronUp" : "chevronRight"}/></button></div>
    {parametersOpen ? <TripParameterPanel form={form} onChange={onFormChange} onClose={onToggleParameters}/> : null}
    <section className="try-say"><h2>试试这样说</h2><div className="prompt-suggestions concept-examples">{examples.map(([art,title,detail,prompt]) => <button type="button" key={title} onClick={() => onChange(prompt)}><span className={`example-art ${art}`}></span><b>{title}</b><small>{detail}</small><i><Icon name="arrow"/></i></button>)}</div></section>
    <p className="generation-disclaimer">没有可靠来源的信息会显示“暂未核验”，不会由 AI 补写。</p>
  </section>;
}
