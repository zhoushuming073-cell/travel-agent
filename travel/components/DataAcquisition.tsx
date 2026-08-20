"use client";

import type { PlanningProgress, TravelProfile } from "../types.ts";

interface Props { request: string; profile: TravelProfile | null; progress: PlanningProgress | null }

const sources = [
  ["景区开放时间", "官方页面 / 公开地图"],
  ["实时天气", "天气 MCP / Open-Meteo"],
  ["热门趋势", "可验证公开来源"],
  ["人流预测", "有证据才生成 Prediction"],
  ["路线距离", "高德 MCP / OSRM"],
  ["高铁交通", "未接实时班次时保持 Unknown"],
  ["周边住宿", "高德 POI / 酒店 MCP"],
  ["餐饮推荐", "路线附近高德 POI"],
];

export function DataAcquisition({ request, profile, progress }: Props) {
  const items = progress?.items ?? [];
  return <div className="data-stage-react">
    <aside className="conversation-rail panel"><div className="rail-head"><span>对话记录</span><small>实时任务</small></div><div className="assistant-intro">✦ 已识别 {profile?.city ?? "目的地"}，正在连接数据工具。</div><p>{request}</p></aside>
    <section className="agent-stage-panel panel data-agent-panel">
      <div className="agent-stage-head centered"><div><span className="section-code">LIVE DATA ACQUISITION</span><h2>AI 正在搜集资料并规划行程</h2><p>正在整合景点、天气、客流与交通信息</p></div><span className="live-chip"><i></i> 数据实时更新中</span></div>
      <div className="evidence-source-grid react-source-grid">{sources.map(([name, provider], index) => <article key={name} className={index < Math.max(2, items.length - 1) ? "done" : "working"}><i>{index < Math.max(2, items.length - 1) ? "✓" : "↻"}</i><div><b>{name}</b><span>{provider}</span><small>{index < Math.max(2, items.length - 1) ? "已连接" : "核验中"}</small></div></article>)}</div>
      <div className="data-stage-lower react-data-lower"><section className="live-discovery-card"><div className="stage-card-title"><strong>景点情报</strong><span>热门与时令推荐</span></div><div className="candidate-skeletons">{[1,2,3,4].map((item) => <i key={item}></i>)}</div><p>候选数量与景点名称只会在工具返回后出现，不沿用其他城市的示例。</p></section><section className="live-risk-card"><div className="stage-card-title"><strong>客流预测</strong><span>趋势分析</span></div><div className="honest-chart"><i></i><i></i><i></i><i></i><span>没有可靠来源时显示 Unknown</span></div></section></div>
      <div className="route-draft-row"><section><strong>路线规划引擎</strong><p>正在等待候选 POI 坐标，然后计算依赖与交通耗时。</p></section><section><strong>Travel Compiler</strong><p>将在真实路线生成后检查必选项、时序、缓冲与开放冲突。</p></section></div>
      <div className="agent-live-log"><b>{progress?.title ?? "正在联网获取可验证的旅行数据……"}</b>{items.slice(-5).map((line) => <span key={line}>{line}</span>)}</div>
    </section>
  </div>;
}

