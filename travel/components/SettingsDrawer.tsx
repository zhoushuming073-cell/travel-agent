"use client";

import { useEffect, useRef, useState } from "react";
import type { TravelFormState } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  open: boolean;
  form: TravelFormState;
  onChange: (form: TravelFormState) => void;
  onClose: () => void;
}

export function SettingsDrawer(props: Props) {
  return props.open ? <SettingsDrawerContent {...props}/> : null;
}

function SettingsDrawerContent({ form, onChange, onClose }: Props) {
  const [draft, setDraft] = useState(form);
  const dialogRef = useRef<HTMLElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => cityRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>("button,input,select,[tabindex]:not([tabindex='-1'])")].filter((item) => !item.hasAttribute("disabled"));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  const set = <K extends keyof TravelFormState>(key: K, value: TravelFormState[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const togglePreference = (value: string) => set("preferences", draft.preferences.includes(value) ? draft.preferences.filter((item) => item !== value) : [...draft.preferences, value]);
  const save = () => { onChange(draft); onClose(); };

  return <>
    <aside ref={dialogRef} className="settings panel settings-drawer open" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="panel-heading"><div><span className="section-code">TRIP PARAMETERS</span><h2 id="settings-title">旅行参数</h2></div><button className="drawer-close" type="button" onClick={onClose} aria-label="关闭旅行参数"><Icon name="close"/></button></div>
      <p className="settings-honesty-note">只有点击“保存参数”后才会应用修改；未设置的内容继续交给 AI 从文字中识别。</p>
      <label className="field-label" htmlFor="city-setting">中国目的地</label><div className="select-wrap city-search-wrap"><span className="field-icon"><Icon name="mapPin"/></span><input ref={cityRef} id="city-setting" value={draft.city} onChange={(event) => set("city", event.target.value)} placeholder="未设置，可直接在旅行描述中说明"/><span className="city-search-state">全国</span></div>
      <label className="field-label" htmlFor="date-setting">出发日期</label><div className="select-wrap"><span className="field-icon"><Icon name="calendar"/></span><input id="date-setting" type="date" value={draft.startDate} onChange={(event) => set("startDate", event.target.value)}/></div>
      <div className="field-label">出行天数 <small>系统默认</small></div><div className="counter-control"><button type="button" aria-label="减少一天" onClick={() => set("days", Math.max(1, draft.days - 1))}>−</button><strong>{draft.days}</strong><span>天</span><button type="button" aria-label="增加一天" onClick={() => set("days", Math.min(14, draft.days + 1))}>＋</button></div>
      <div className="two-field-grid"><div><label className="field-label" htmlFor="budget-setting">总预算</label><div className="select-wrap compact-control"><span className="field-icon"><Icon name="wallet"/></span><input id="budget-setting" type="number" min="0" value={draft.budget || ""} onChange={(event) => set("budget", Number(event.target.value) || 0)} placeholder="未设置"/></div></div><div><label className="field-label" htmlFor="party-setting">出行人数 <small>系统默认</small></label><div className="select-wrap compact-control"><span className="field-icon"><Icon name="users"/></span><input id="party-setting" type="number" min="1" max="20" value={draft.partySize} onChange={(event) => set("partySize", Number(event.target.value))}/></div></div></div>
      <div className="field-label">旅行偏好</div><div className="chips">{["自然", "摄影", "人文", "美食", "亲子", "夜景"].map((value) => <button className={`chip${draft.preferences.includes(value) ? " active" : ""}`} key={value} type="button" onClick={() => togglePreference(value)}>{value}</button>)}</div>
      <div className="field-label">出行节奏 <small>系统默认</small></div><div className="segmented">{[["relax","轻松"],["medium","适中"],["tight","紧凑"]].map(([value,label]) => <button key={value} type="button" className={draft.pace === value ? "active" : ""} onClick={() => set("pace", value)}>{label}</button>)}</div>
      <label className="field-label" htmlFor="transport-setting">交通方式 <small>系统默认</small></label><div className="select-wrap muted-select"><select id="transport-setting" value={draft.transport} onChange={(event) => set("transport", event.target.value)}><option>公共交通优先</option><option>道路距离优先</option><option>少换区优先</option></select></div>
      <label className="field-label" htmlFor="hotel-setting">住宿偏好</label><div className="select-wrap muted-select"><select id="hotel-setting" value={draft.hotelPreference} onChange={(event) => set("hotelPreference", event.target.value)}><option value="">未设置</option><option>交通方便</option><option>景区附近</option><option>预算优先</option><option>品质优先</option></select></div>
      <div className="drawer-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button full" type="button" onClick={save}><span>保存参数</span><Icon name="check"/></button></div>
    </aside>
    <button className="drawer-backdrop react-backdrop" type="button" onClick={onClose} aria-label="关闭旅行参数"/>
  </>;
}
