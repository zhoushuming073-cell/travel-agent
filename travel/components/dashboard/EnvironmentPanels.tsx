"use client";

import { MOTION, weatherMotion } from "../../lib/animationCatalog.ts";
import type { UiPlan } from "../../types.ts";
import { Icon } from "../Icon.tsx";
import { LottieMotion } from "../LottieMotion.tsx";

export function WeatherPanel({ plan, selectedDay }: { plan: UiPlan; selectedDay: number | null }) {
  const selected = plan.daysPlan.find((day) => day.day === selectedDay) ?? plan.daysPlan[0];
  const forecast = plan.weather?.forecast16?.length ? plan.weather.forecast16 : plan.daysPlan.map((day) => day.weather).filter(Boolean);
  const tripDates = new Set(plan.daysPlan.map((day) => day.date));
  const hasFullForecast = Boolean(plan.weather?.forecast16?.length);
  return <section className="ready-weather-card"><header><b>{plan.city} · {hasFullForecast ? "Open-Meteo 未来 16 天" : "行程天气"}</b><span>{hasFullForecast && plan.weather?.fetchedAt ? `更新于 ${new Date(plan.weather.fetchedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "旧方案未保存 16 天快照，重新规划后补齐"}</span></header><div className="weather-forecast-row sixteen-day">{forecast.map((weather) => { const tripDate = tripDates.has(weather?.date ?? ""); const selectedDate = selected?.date === weather?.date; return <article className={`${selectedDate ? "active " : ""}${tripDate ? "trip-day" : ""}`.trim()} key={weather?.date}><small>{weather?.date?.slice(5).replace("-", "/") ?? "日期待定"}{tripDate ? " · 行程" : ""}</small><i><LottieMotion src={weatherMotion(weather?.weatherCode, false, weather?.windSpeed)} className="weather-motion" label={`${weather?.date ?? ""}天气图标`} fallback={<Icon name="cloud"/>}/></i><strong>{weather?.quality === "forecast" ? `${weather.temperatureMin ?? "—"}° / ${weather.temperatureMax ?? "—"}°` : "待核验"}</strong><span>{weather?.quality === "forecast" ? `降雨 ${weather.precipitationProbability ?? "—"}%` : "尚不可预报"}</span></article>; })}</div>{selected && <p className="weather-note"><b>{selected.date}</b>{selected.weather?.quality === "forecast" ? Number(selected.weather.precipitationProbability ?? 0) >= 60 ? "降雨概率较高，建议保留室内备选。" : "当前预报未触发强降雨替换规则。" : "出行日期可能超过 Open-Meteo 未来 16 天窗口，临近出发时再复核。"}</p>}</section>;
}

export function CrowdPanel({ plan }: { plan: UiPlan }) {
  const facts = plan.travelFacts?.filter((fact) => fact.field === "拥挤风险") ?? [];
  const record = (value: unknown) => typeof value === "object" && value ? value as Record<string, unknown> : {};
  const minute = (value: unknown) => { const [hour = 0, min = 0] = String(value ?? "").split(":").map(Number); return hour * 60 + min; };
  const basisGroups = [
    { id: "external", label: "官方/外部数据", natures: new Set(["forecast", "map-signal"]) },
    { id: "trend", label: "公开趋势", natures: new Set(["public-trend"]) },
    { id: "model", label: "规则/模型预测", natures: new Set(["calendar", "place-prior"]) },
  ];
  return <section className="ready-crowd-card">
    <header><b>景点人流预测</b><span>0–100 风险指数 · 预测不等于实时人流</span></header>
    {facts.length ? facts.map((fact) => {
      const value = record(fact.value);
      const risk = Math.round(Number(value.score ?? value.probability ?? 0));
      const label = String(value.label ?? "预测待生成");
      const band = record(value.forecastBand);
      const range = Number.isFinite(Number(band.low)) && Number.isFinite(Number(band.high)) ? `${Math.round(Number(band.low))}–${Math.round(Number(band.high))}` : `${risk}`;
      const confidence = String(value.confidenceLabel ?? (fact.confidence >= 0.72 ? "较高" : fact.confidence >= 0.55 ? "中等" : "较低"));
      const coverage = Math.round(Number(value.evidenceCoverage ?? 0));
      const contributions = Array.isArray(value.factorContributions) ? value.factorContributions as Array<Record<string, unknown>> : [];
      const windows = Array.isArray(value.timeWindows) ? value.timeWindows.map(record) : [];
      const visitTime = String(value.visitTime ?? "");
      const currentWindow = windows.length ? [...windows].sort((left, right) => Math.abs(minute(left.time) - minute(visitTime)) - Math.abs(minute(right.time) - minute(visitTime)))[0] : null;
      const advice = record(value.visitAdvice);
      const tone = risk >= 85 ? "extreme" : risk >= 70 ? "crowded" : risk >= 55 ? "busy" : risk >= 35 ? "normal" : "calm";
      return <article className={`crowd-prediction-card tone-${tone}`} key={fact.id}>
        <div className="crowd-card-heading"><span><b>{fact.subject}</b><small>{String(value.visitDate ?? "日期待定")} · 计划 {visitTime || "时间待定"} 到访</small></span><span className="crowd-state"><strong>{label}</strong><b>{risk}<small>/100</small></b></span></div>
        <div className="crowd-meter" role="img" aria-label={`预计人流风险指数 ${risk}，预测区间 ${range}`}><i style={{ width: `${risk}%` }}></i></div>
        <div className="crowd-meta"><span>计划时段：<b>{String(currentWindow?.label ?? label)}</b></span><span>预测区间：<b>{range}</b></span><span>置信度：<b>{confidence}</b></span><span>证据覆盖：<b>{coverage}%</b></span></div>
        {windows.length ? <div className="crowd-day-trend" aria-label={`${fact.subject} 当天分时人流预测`}>{windows.map((window) => { const active = currentWindow?.time === window.time; const score = Math.round(Number(window.score ?? 0)); return <span className={active ? "active" : ""} key={String(window.time)}><i style={{ height: `${Math.max(8, score)}%` }}></i><b>{String(window.time)}</b><small>{String(window.label)}</small></span>; })}</div> : null}
        <div className="crowd-window-grid"><span><small>推荐</small><b>{String(value.recommendedWindow ?? "暂无明显低谷")}</b></span><span><small>次推荐</small><b>{String(value.secondaryRecommendedWindow ?? "暂无次优时段")}</b></span><span><small>尽量避开</small><b>{String(value.avoidWindow ?? "暂无明显高峰")}</b></span></div>
        {advice.message ? <p className="crowd-shift-tip"><Icon name="alert"/>{String(advice.message)}</p> : null}
        {confidence === "较低" || value.dataQualityNote ? <p className="crowd-quality-note">{String(value.dataQualityNote ?? "参考数据有限，预测置信度较低")}</p> : null}
        <details className="crowd-basis"><summary>查看预测依据</summary><div>{basisGroups.map((group) => { const rows = contributions.filter((item) => group.natures.has(String(item.nature))); return <section key={group.id}><b>{group.label}</b>{rows.length ? rows.map((item) => <p key={`${group.id}-${String(item.id)}`}><span>{String(item.label)}</span><small>{String(item.evidence)}</small><em>{Number(item.impact) > 0 ? "+" : ""}{Math.round(Number(item.impact ?? 0))}</em></p>) : <p className="basis-unavailable"><span>本次无可用信号</span><small>{group.id === "external" ? "未接入官方实时客流；天气/地图信号缺失时不补造" : group.id === "trend" ? "未取得可归因公开趋势，不以模型内容冒充观测" : "仍保留基础日期与景点类型规则"}</small></p>}</section>; })}</div><footer>所有分值均为预测风险，不是当前游客人数、园内人数或精确排队人数。</footer></details>
      </article>;
    }) : <p className="empty-evidence">基础预测也未生成，请重新规划；系统不会用“Unknown”掩盖模型故障。</p>}
    <footer>节假日、到访时段、景点类型、天气、公开趋势与可比日期信号分别计分；缺少外部数据时自动降为低置信度预测。</footer>
  </section>;
}

export function TrendsPanel({ plan }: { plan: UiPlan }) {
  const facts = plan.travelFacts?.filter((fact) => fact.field === "趋势热度" || fact.field === "时令适配") ?? [];
  const rows = [...new Map(facts.map((fact) => [fact.subject, fact.subject])).keys()].slice(0, 6);
  return <section className="ready-trend-card"><header><b><LottieMotion src={MOTION.fire} className="trend-fire-motion" label="近期关注信号"/>近期关注 × 时令报道信号</b><span>均为公开网络弱信号，不代表实时客流或到访日物候</span></header>{rows.length ? rows.map((subject) => { const hot = facts.find((fact) => fact.subject === subject && fact.field === "趋势热度"); const season = facts.find((fact) => fact.subject === subject && fact.field === "时令适配"); const value = (fact?: typeof hot) => typeof fact?.value === "object" && fact.value ? fact.value as Record<string, unknown> : {}; const hotScore = hot?.status === "predicted" ? Number(value(hot).score) : null; const seasonScore = season?.status === "predicted" ? Number(value(season).score) : null; const sourceUrl = season?.sourceUrl || hot?.sourceUrl; return <article key={subject}><div><strong>{subject}</strong><small>{seasonScore != null ? String(value(season).label ?? "近期时令报道信号") : "没有可用于到访日的时令报道信号"}</small></div><span><b>{hotScore != null ? hotScore : "—"}</b><small>关注信号</small></span><span><b>{seasonScore != null ? seasonScore : "—"}</b><small>时令信号</small></span>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">来源</a> : <em>暂无来源</em>}</article>; }) : <p className="empty-evidence">当前没有可归因到路线景点的趋势或时令报道信号。</p>}</section>;
}
