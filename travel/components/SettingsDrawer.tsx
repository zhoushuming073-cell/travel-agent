"use client";

import type { TravelFormState } from "../types.ts";

interface Props {
  open: boolean;
  form: TravelFormState;
  onChange: (form: TravelFormState) => void;
  onClose: () => void;
}

export function SettingsDrawer({ open, form, onChange, onClose }: Props) {
  const set = <K extends keyof TravelFormState>(key: K, value: TravelFormState[K]) => onChange({ ...form, [key]: value });
  const togglePreference = (value: string) => set("preferences", form.preferences.includes(value) ? form.preferences.filter((item) => item !== value) : [...form.preferences, value]);
  return <>
    <aside className={`settings panel settings-drawer${open ? " open" : ""}`} aria-label="行程设置" aria-hidden={!open}>
      <div className="panel-heading"><div><span className="section-code">TRIP PARAMETERS</span><h2>旅行参数</h2></div><button className="drawer-close" type="button" onClick={onClose}>×</button></div>
      <p className="settings-honesty-note">自然语言会先交给 DeepSeek 结构化；这里的参数是补充默认值，AI 返回后会同步更新。</p>
      <label className="field-label" htmlFor="city-setting">中国目的地</label><div className="select-wrap city-search-wrap"><span className="field-icon">⌖</span><input id="city-setting" value={form.city} onChange={(event) => set("city", event.target.value)} placeholder="输入中国城市、区县或旅游目的地"/><span className="city-search-state">全国</span></div>
      <label className="field-label" htmlFor="date-setting">出发日期</label><div className="select-wrap"><span className="field-icon">日</span><input id="date-setting" type="date" value={form.startDate} onChange={(event) => set("startDate", event.target.value)}/></div>
      <div className="field-label">出行天数</div><div className="counter-control"><button type="button" aria-label="减少一天" onClick={() => set("days", Math.max(1, form.days - 1))}>−</button><strong>{form.days}</strong><span>天</span><button type="button" aria-label="增加一天" onClick={() => set("days", Math.min(14, form.days + 1))}>＋</button></div>
      <div className="two-field-grid"><div><label className="field-label" htmlFor="budget-setting">总预算</label><div className="select-wrap compact-control"><span className="field-icon">¥</span><input id="budget-setting" type="number" min="0" value={form.budget} onChange={(event) => set("budget", Number(event.target.value))}/></div></div><div><label className="field-label" htmlFor="party-setting">出行人数</label><div className="select-wrap compact-control"><span className="field-icon">人</span><input id="party-setting" type="number" min="1" max="20" value={form.partySize} onChange={(event) => set("partySize", Number(event.target.value))}/></div></div></div>
      <div className="field-label">偏好景点</div><div className="chips">{["自然", "摄影", "人文", "美食", "亲子", "夜景"].map((value) => <button className={`chip${form.preferences.includes(value) ? " active" : ""}`} key={value} type="button" onClick={() => togglePreference(value)}>{value}</button>)}</div>
      <div className="field-label">出行节奏</div><div className="segmented">{[["relax","轻松"],["medium","适中"],["tight","紧凑"]].map(([value,label]) => <button key={value} type="button" className={form.pace === value ? "active" : ""} onClick={() => set("pace", value)}>{label}</button>)}</div>
      <label className="field-label" htmlFor="transport-setting">路线偏好</label><div className="select-wrap muted-select"><select id="transport-setting" value={form.transport} onChange={(event) => set("transport", event.target.value)}><option>公共交通优先</option><option>道路距离优先</option><option>少换区优先</option></select></div>
      <label className="field-label" htmlFor="hotel-setting">住宿偏好</label><div className="select-wrap muted-select"><select id="hotel-setting" value={form.hotelPreference} onChange={(event) => set("hotelPreference", event.target.value)}><option>交通方便</option><option>景区附近</option><option>预算优先</option><option>品质优先</option></select></div>
      <button className="primary-button full" type="button" onClick={onClose}><span>保存参数</span><b>✓</b></button>
    </aside>
    {open && <button className="drawer-backdrop react-backdrop" type="button" onClick={onClose} aria-label="关闭旅行参数"/>}
  </>;
}
