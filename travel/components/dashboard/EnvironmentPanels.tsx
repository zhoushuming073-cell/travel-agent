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
  return <section className="ready-crowd-card">
    <header><b>到访时段拥挤风险</b><span>Crowd Risk v2 预测区间；不是实时人数</span></header>
    {facts.length ? facts.slice(0, 8).map((fact) => {
      const value = typeof fact.value === "object" && fact.value ? fact.value as Record<string, unknown> : {};
      const risk = Math.round(Number(value.score ?? value.probability ?? 0));
      const label = String(value.label ?? "待核验");
      const band = typeof value.forecastBand === "object" && value.forecastBand ? value.forecastBand as Record<string, unknown> : {};
      const range = Number.isFinite(Number(band.low)) && Number.isFinite(Number(band.high)) ? `${Math.round(Number(band.low))}–${Math.round(Number(band.high))}%` : `${risk}%`;
      const confidence = String(value.confidenceLabel ?? (fact.confidence >= 0.72 ? "较高" : fact.confidence >= 0.55 ? "中等" : "较低"));
      const coverage = Math.round(Number(value.evidenceCoverage ?? 0));
      const contributions = Array.isArray(value.factorContributions) ? value.factorContributions as Array<Record<string, unknown>> : [];
      const topFactors = contributions.filter((item) => Number(item.impact) !== 0).sort((a, b) => Math.abs(Number(b.impact)) - Math.abs(Number(a.impact))).slice(0, 2).map((item) => `${String(item.label)} ${Number(item.impact) > 0 ? "+" : ""}${Math.round(Number(item.impact))}`).join(" · ");
      return <div key={fact.id}>
        <span><b>{fact.subject}</b><small>{String(value.visitDate ?? "")} {String(value.visitTime ?? "")} · {topFactors || "日期与场所类型基线"}</small></span>
        <i aria-label={`预测拥挤风险区间 ${range}`}><b style={{ width: `${risk}%` }}></b></i>
        <em>{fact.status === "predicted" ? `${label} · ${range}` : "暂未核验"}<small>置信度{confidence} · 证据覆盖 {coverage}%</small><small>{value.recommendedWindow ? `建议 ${String(value.recommendedWindow)}` : ""}</small></em>
      </div>;
    }) : <p className="empty-evidence">基础预测也未生成，请重新规划；系统不会用“Unknown”掩盖模型故障。</p>}
    <footer>节假日、到访时段、景点承载特征、天气与近期公开趋势分别计分；官方预约余量未接入时会降低置信度。</footer>
  </section>;
}

export function TrendsPanel({ plan }: { plan: UiPlan }) {
  const facts = plan.travelFacts?.filter((fact) => fact.field === "趋势热度" || fact.field === "时令适配") ?? [];
  const rows = [...new Map(facts.map((fact) => [fact.subject, fact.subject])).keys()].slice(0, 6);
  return <section className="ready-trend-card"><header><b><LottieMotion src={MOTION.fire} className="trend-fire-motion" label="近期关注信号"/>近期关注 × 时令报道信号</b><span>均为公开网络弱信号，不代表实时客流或到访日物候</span></header>{rows.length ? rows.map((subject) => { const hot = facts.find((fact) => fact.subject === subject && fact.field === "趋势热度"); const season = facts.find((fact) => fact.subject === subject && fact.field === "时令适配"); const value = (fact?: typeof hot) => typeof fact?.value === "object" && fact.value ? fact.value as Record<string, unknown> : {}; const hotScore = hot?.status === "predicted" ? Number(value(hot).score) : null; const seasonScore = season?.status === "predicted" ? Number(value(season).score) : null; const sourceUrl = season?.sourceUrl || hot?.sourceUrl; return <article key={subject}><div><strong>{subject}</strong><small>{seasonScore != null ? String(value(season).label ?? "近期时令报道信号") : "没有可用于到访日的时令报道信号"}</small></div><span><b>{hotScore != null ? hotScore : "—"}</b><small>关注信号</small></span><span><b>{seasonScore != null ? seasonScore : "—"}</b><small>时令信号</small></span>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">来源</a> : <em>暂无来源</em>}</article>; }) : <p className="empty-evidence">当前没有可归因到路线景点的趋势或时令报道信号。</p>}</section>;
}
