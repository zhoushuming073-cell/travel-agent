"use client";

import type { TravelFormState } from "../types.ts";

interface Props {
  value: string;
  form: TravelFormState;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onOpenSettings: () => void;
}

const examples = [
  ["great-wall", "带父母去北京玩4天", "想轻松一些，预算3000左右", "带父母去北京玩4天，想看长城和历史文化，行程轻松一些，预算3000元左右。"],
  ["culture-city", "国庆去成都5天", "喜欢美食和人文，尽量避峰", "国庆去成都玩5天，喜欢美食和人文，希望避开人多的地方。"],
  ["skyline", "带孩子去上海玩3天", "需要合理规划路线和时间", "带孩子去上海迪士尼玩3天，需要合理规划路线和时间。"],
];

export function EmptyTripHero({ value, form, busy, onChange, onSubmit, onOpenSettings }: Props) {
  const preference = form.preferences.join("、") || form.style;
  return <section className="empty-stage react-empty-stage" aria-labelledby="hero-title">
    <div className="empty-copy"><h1 id="hero-title">智能旅游助手</h1><p>从一句想法，到一份 <strong>真正能出发的行程</strong></p><div className="hero-capabilities"><span>⌁ 实时发现当季景点</span><span>▥ 分析信息可信度</span><span>✦ AI 生成多套路线</span><span>⌖ 自动检查行程风险</span></div></div>
    <div className="empty-layout">
      <div className="prompt-studio"><div className="query-card">
        <div className="query-input-wrap"><div className="query-content"><label htmlFor="travel-request">描述你的旅行想法…</label><textarea id="travel-request" rows={5} value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如：2026年10月去杭州玩4天，两个人，喜欢自然和摄影，必须去西湖和灵隐寺，希望不要太赶。"/><div className="query-helper"><span>日期、人数、必选项与时间限制会作为硬约束</span><button type="button" onClick={onOpenSettings}>补充参数</button></div></div></div>
        <button className="primary-button" type="button" onClick={onSubmit} disabled={busy || !value.trim()}><span>{busy ? "智能体正在工作" : "交给智能体规划"}</span><b>↗</b></button>
      </div></div>
      <div className="city-illustration" aria-hidden="true"><img className="jiangnan-hero-art" src="/travel/assets/jiangnan-hero-v1.png" alt=""/></div>
    </div>
    <div className="quick-param-grid" aria-label="快捷旅行参数">
      {[['¥','预算',form.budget ? `¥${form.budget}` : '不限'],['▣','日期',form.startDate || '未设置'],['◔','天数',`${form.days}天`],['♙','人数',`${form.partySize}人`],['⌖','目的地',form.city],['♡','偏好',preference],['◴','节奏',form.pace === 'relax' ? '轻松' : '适中'],['▤','交通方式',form.transport],['•••','更多','设置']].map(([icon,label,strong]) => <button type="button" onClick={onOpenSettings} key={label}><i>{icon}</i><span>{label}<strong>{strong}</strong></span></button>)}
    </div>
    <section className="try-say"><h2>试试这样说</h2><div className="prompt-suggestions concept-examples">{examples.map(([art,title,detail,prompt]) => <button type="button" key={title} onClick={() => onChange(prompt)}><span className={`example-art ${art}`}></span><b>{title}</b><small>{detail}</small><i>↗</i></button>)}</div></section>
    <p className="generation-disclaimer">所有无法核验的信息都会明确标为 Unknown，不由 AI 补写。</p>
  </section>;
}

