"use client";

import { useEffect, useMemo, useState } from "react";
import { MOTION } from "../lib/animationCatalog.ts";
import type { PlanningProgress, TravelProfile } from "../types.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { LottieMotion } from "./LottieMotion.tsx";

interface Props { request: string; profile: TravelProfile | null; progress: PlanningProgress | null; onCancel?: () => void }
type SourceState = NonNullable<PlanningProgress["sources"]>[number]["state"];

interface SourceDefinition {
  id: string;
  label: string;
  query: (city: string) => string;
  fallbackHost: string;
  fallbackProvider: string;
  icon: IconName;
}

export const MIN_CARD_DWELL_MS = 3400;

const expectedSources: SourceDefinition[] = [
  { id: "spots", label: "景点实体与开放信息", query: (city) => `${city} 景点 开放时间 官方信息`, fallbackHost: "ditu.amap.com", fallbackProvider: "等待地图与景区信息源", icon: "mapPin" },
  { id: "weather", label: "未来天气与出行条件", query: (city) => `${city} 未来天气 逐日预报`, fallbackHost: "open-meteo.com", fallbackProvider: "等待 Open-Meteo / 天气工具", icon: "cloudSun" },
  { id: "routing", label: "公共交通与相邻路段", query: (city) => `${city} 公交 地铁 路线时间`, fallbackHost: "ditu.amap.com", fallbackProvider: "等待高德路线工具", icon: "train" },
  { id: "hotels", label: "住宿候选与位置关系", query: (city) => `${city} 住宿候选 景点通勤`, fallbackHost: "hotel-search.local", fallbackProvider: "等待住宿候选工具", icon: "mapPin" },
  { id: "crowd", label: "拥挤风险与避峰信号", query: (city) => `${city} 景点 客流 预约 热度`, fallbackHost: "crowd-risk.local", fallbackProvider: "等待拥挤风险模型", icon: "users" },
  { id: "season", label: "时令景观与近期趋势", query: (city) => `${city} 当季景观 近期热门`, fallbackHost: "trend-search.local", fallbackProvider: "等待公开趋势信号", icon: "sparkles" },
];

const stateLabel: Record<SourceState, string> = {
  waiting: "等待检索", loading: "正在检索", success: "取证完成", error: "检索失败", unavailable: "暂不可用",
};

function relevantLines(items: string[], definition: SourceDefinition): string[] {
  const words: Record<string, RegExp> = {
    spots: /景点|开放|实体|候选/i, weather: /天气|气温|降雨/i, routing: /交通|公交|地铁|矩阵|路线/i,
    hotels: /酒店|住宿/i, crowd: /拥挤|客流|预约|人流/i, season: /时令|趋势|热门|季节/i,
  };
  return items.filter((line) => words[definition.id]?.test(line)).slice(-2);
}

function safeDetail(value?: string): string {
  return value?.replaceAll("Unknown", "暂未核验").trim() || "正在等待该信息源返回可核验内容。";
}

export function DataAcquisition({ request, profile, progress, onCancel }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const items = progress?.items ?? [];
  const actual = useMemo(() => new Map((progress?.sources ?? []).map((source) => [source.id, source])), [progress?.sources]);
  const city = profile?.city || "目的地";
  const cards = expectedSources.map((definition) => {
    const source = actual.get(definition.id);
    return {
      ...definition,
      state: (source?.state ?? "waiting") as SourceState,
      provider: source?.provider || definition.fallbackProvider,
      detail: safeDetail(source?.detail),
      lines: relevantLines(items, definition),
    };
  });
  const completedCount = cards.filter((card) => card.state === "success").length;
  const activeCount = cards.filter((card) => card.state === "loading" || card.state === "waiting").length;
  const unavailableCount = cards.filter((card) => card.state === "error" || card.state === "unavailable").length;
  const allSettled = activeCount === 0;

  useEffect(() => {
    if (activeIndex >= cards.length) {
      if (!allSettled) {
        const restart = window.setTimeout(() => setActiveIndex(0), MIN_CARD_DWELL_MS);
        return () => window.clearTimeout(restart);
      }
      return;
    }
    const timer = window.setTimeout(() => {
      setActiveIndex((current) => current < cards.length - 1 ? current + 1 : allSettled ? cards.length : 0);
    }, MIN_CARD_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, allSettled, cards.length]);

  const summaryActive = activeIndex >= cards.length;
  const positionLabel = summaryActive ? "信息搜集完成" : `正在浏览第 ${activeIndex + 1} / ${cards.length} 个信息源`;

  return <div className="data-stage-react">
    <section className="agent-stage-panel panel data-agent-panel">
      <div className="agent-stage-head centered research-stage-head">
        <div><span className="section-code">STAGE 2 · RESEARCH</span><h2>AI 正在搜集与核验旅行信息</h2><p>按照真实任务返回顺序逐项取证，每张卡至少停留 {MIN_CARD_DWELL_MS / 1000} 秒。</p></div>
        <LottieMotion src={MOTION.search} className="research-motion" label="正在联网搜索旅行信息" fallback={<Icon name="search"/>}/>
        {onCancel ? <button className="task-cancel" type="button" onClick={onCancel}>取消规划</button> : null}
      </div>

      <div className="research-overview" aria-label="实时数据搜集概况">
        <span><b>{completedCount}</b> 已返回</span><span><b>{activeCount}</b> 检索中</span><span><b>{unavailableCount}</b> 已降级</span>
        <div><i style={{ width: `${Math.round((completedCount + unavailableCount) / cards.length * 100)}%` }}/></div>
      </div>

      <div className="research-stack-shell">
        <div className="research-card-stack" aria-live="polite" aria-label={positionLabel}>
          {cards.map((card, index) => {
            const offset = index - activeIndex;
            const stackClass = offset === 0 ? "is-active" : offset === 1 ? "is-next" : offset === 2 ? "is-after-next" : offset < 0 ? "is-past" : "is-queued";
            return <article className={`research-source-card ${stackClass} state-${card.state}`} key={card.id} aria-hidden={offset !== 0}>
              <header className="research-card-copy">
                <span className="research-card-number">{String(index + 1).padStart(2, "0")}</span>
                <div><small>正在检索「{card.query(city)}」</small><h3><Icon name={card.icon}/> {card.label}</h3></div>
                <b className={`research-source-state ${card.state}`}>{stateLabel[card.state]}</b>
              </header>
              <div className="evidence-browser-window">
                <div className="evidence-browser-bar">
                  <span className="browser-dots"><i/><i/><i/></span>
                  <span className="browser-address"><Icon name="search"/>{card.fallbackHost}</span>
                  <em>实时取证快照</em>
                </div>
                <div className="evidence-browser-body">
                  <div className="snapshot-source-icon"><Icon name={card.icon}/></div>
                  <div className="snapshot-result">
                    <small>当前提供方 · {card.provider}</small>
                    <strong>{card.label} · {stateLabel[card.state]}</strong>
                    <p>{card.detail}</p>
                    {card.lines.length ? <ul>{card.lines.map((line) => <li key={line}>{line.replaceAll("Unknown", "暂未核验")}</li>)}</ul> : <div className="snapshot-placeholder-lines"><i/><i/><i/></div>}
                  </div>
                  {(card.state === "loading" || card.state === "waiting") && <span className="snapshot-scan-line" aria-hidden="true"/>}
                </div>
              </div>
              <footer><span><Icon name="check"/> 本次任务实时返回摘要</span><small>不是预制搜索结果</small></footer>
            </article>;
          })}

          <article className={`research-source-card research-summary-card ${summaryActive ? "is-active" : "is-queued"}`} aria-hidden={!summaryActive}>
            <header className="research-card-copy"><span className="research-card-number">07</span><div><small>本轮联网搜集结果</small><h3><Icon name="search"/> 已完成信息源巡检</h3></div><b className="research-source-state success">已汇总</b></header>
            <div className="evidence-browser-window summary">
              <div className="evidence-browser-bar"><span className="browser-dots"><i/><i/><i/></span><span className="browser-address"><Icon name="search"/>travel-evidence.workspace</span><em>任务摘要</em></div>
              <div className="research-summary-grid"><div><strong>{completedCount}</strong><span>成功返回</span></div><div><strong>{unavailableCount}</strong><span>明确降级</span></div><div><strong>{items.length}</strong><span>进度事件</span></div></div>
              <p>{progress?.title ?? "正在整理本次任务已经返回的数据"}</p>
            </div>
            <footer><span><Icon name="check"/> 后续规划只使用已返回证据</span><small>缺失项将保持未知</small></footer>
          </article>
        </div>
        <div className="research-stack-status"><span>{positionLabel}</span><div>{[...cards, { id: "summary" }].map((card, index) => <i className={index === activeIndex ? "active" : index < activeIndex ? "done" : ""} key={card.id}/>)}</div></div>
      </div>

      <p className="research-request-context"><Icon name="sparkles"/> 当前取证范围：{city} · {request.slice(0, 88)}{request.length > 88 ? "…" : ""}</p>
    </section>
  </div>;
}
