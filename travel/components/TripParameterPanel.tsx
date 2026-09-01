"use client";

import type { TravelFormState } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  form: TravelFormState;
  onChange: (form: TravelFormState) => void;
  onClose: () => void;
}

const PREFERENCES = ["自然", "摄影", "人文", "美食", "亲子", "夜景"];
const PACES = [["relax", "轻松"], ["medium", "适中"], ["tight", "紧凑"]] as const;

export function TripParameterPanel({ form, onChange, onClose }: Props) {
  const set = <K extends keyof TravelFormState>(key: K, value: TravelFormState[K]) => onChange({ ...form, [key]: value });
  const togglePreference = (value: string) => set("preferences", form.preferences.includes(value)
    ? form.preferences.filter((item) => item !== value)
    : [...form.preferences, value]);

  return <section className="inline-parameter-panel panel" aria-labelledby="inline-parameters-title">
    <header>
      <div><span className="section-code">TRIP PARAMETERS</span><h2 id="inline-parameters-title">完善旅行参数</h2><p>参数会直接同步到本次规划；文字描述中的明确要求仍然优先。</p></div>
      <button className="parameter-panel-close" type="button" onClick={onClose}><Icon name="chevronUp"/>收起</button>
    </header>
    <div className="parameter-fields-grid">
      <label className="parameter-field wide"><span>中国目的地</span><div className="select-wrap city-search-wrap"><i className="field-icon"><Icon name="mapPin"/></i><input value={form.city} onChange={(event) => set("city", event.target.value)} placeholder="例如：杭州"/><small>全国</small></div></label>
      <label className="parameter-field"><span>出发日期</span><div className="select-wrap"><i className="field-icon"><Icon name="calendar"/></i><input type="date" value={form.startDate} onChange={(event) => set("startDate", event.target.value)}/></div></label>
      <div className="parameter-field"><span>出行天数</span><div className="counter-control"><button type="button" aria-label="减少一天" onClick={() => set("days", Math.max(1, form.days - 1))}><Icon name="minus"/></button><strong>{form.days}</strong><em>天</em><button type="button" aria-label="增加一天" onClick={() => set("days", Math.min(7, form.days + 1))}><Icon name="plus"/></button></div></div>
      <label className="parameter-field"><span>总预算</span><div className="select-wrap"><i className="field-icon"><Icon name="wallet"/></i><input type="number" min="0" value={form.budget || ""} onChange={(event) => set("budget", Number(event.target.value) || 0)} placeholder="未设置"/></div></label>
      <label className="parameter-field"><span>出行人数</span><div className="select-wrap"><i className="field-icon"><Icon name="users"/></i><input type="number" min="1" max="20" value={form.partySize} onChange={(event) => set("partySize", Math.max(1, Number(event.target.value) || 1))}/></div></label>
      <div className="parameter-field preference-field"><span>旅行偏好</span><div className="chips">{PREFERENCES.map((value) => <button className={`chip${form.preferences.includes(value) ? " active" : ""}`} key={value} type="button" onClick={() => togglePreference(value)}>{value}</button>)}</div></div>
      <div className="parameter-field"><span>出行节奏</span><div className="segmented">{PACES.map(([value,label]) => <button key={value} type="button" className={form.pace === value ? "active" : ""} onClick={() => set("pace", value)}>{label}</button>)}</div></div>
      <label className="parameter-field"><span>交通方式</span><div className="select-wrap"><select value={form.transport} onChange={(event) => set("transport", event.target.value)}><option>公共交通优先</option><option>道路距离优先</option><option>少换区优先</option></select></div></label>
      <label className="parameter-field"><span>住宿偏好</span><div className="select-wrap"><select value={form.hotelPreference} onChange={(event) => set("hotelPreference", event.target.value)}><option value="">未设置</option><option>交通方便</option><option>景区附近</option><option>预算优先</option><option>品质优先</option></select></div></label>
      <label className="parameter-field reasoning-toggle"><span>规划模式</span><button type="button" role="switch" aria-checked={form.deepReasoning} className={form.deepReasoning ? "active" : ""} onClick={() => set("deepReasoning", !form.deepReasoning)}><i></i><b>{form.deepReasoning ? "深度规划" : "快速规划"}</b></button><small>{form.deepReasoning ? "V4 Pro 先做限时约束推理，再生成并校验方案" : "跳过独立推理备忘录，仍由 V4 Pro 生成并校验"}</small></label>
    </div>
  </section>;
}
