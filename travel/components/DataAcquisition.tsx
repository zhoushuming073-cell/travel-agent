"use client";

import type { PlanningProgress, TravelProfile } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props { request: string; profile: TravelProfile | null; progress: PlanningProgress | null; onCancel?: () => void }

const expectedSources = [
  ["spots", "景点实体与常规开放信息"],
  ["weather", "天气预报"],
  ["routing", "规划前公共交通矩阵"],
  ["hotels", "住宿候选（非指定日期实时价格）"],
  ["crowd", "拥挤风险预测"],
  ["season", "近期趋势与时令报道信号"],
];

const stateLabel = {
  waiting: "等待中", loading: "查询中", success: "已返回", error: "查询失败", unavailable: "暂不可用",
};

export function DataAcquisition({ request, profile, progress, onCancel }: Props) {
  const items = progress?.items ?? [];
  const actual = new Map((progress?.sources ?? []).map((source) => [source.id, source]));
  return <div className="data-stage-react">
    <aside className="conversation-rail panel"><div className="rail-head"><span>原始需求</span><small>实时任务</small></div><div className="assistant-intro"><Icon name="sparkles"/> 已识别 {profile?.city ?? "目的地"}，正在连接数据工具。</div><p>{request}</p></aside>
    <section className="agent-stage-panel panel data-agent-panel">
      <div className="agent-stage-head centered"><div><span className="section-code">LIVE DATA</span><h2>正在获取可核验的旅行信息</h2><p>完成状态只来自服务端实际返回，不用条目数量推测。</p></div>{onCancel ? <button className="task-cancel" type="button" onClick={onCancel}>取消规划</button> : null}</div>
      <div className="evidence-source-grid react-source-grid">{expectedSources.map(([id, label]) => {
        const source = actual.get(id);
        const state = source?.state ?? "loading";
        const completedLabel = state === "success" && id === "crowd" ? "已生成预测" : state === "success" && id === "season" ? "已取得公开信号" : stateLabel[state];
        return <article key={id} className={state}><i>{state === "success" ? "✓" : state === "error" ? "!" : "●"}</i><div><b>{label}</b><span>{source?.provider || "等待实际提供方返回"}</span><small>{completedLabel}{source?.detail ? " · " + source.detail : ""}</small></div></article>;
      })}</div>
      <div className="data-truth-grid">
        <section><Icon name="search"/><div><strong>先核验实体</strong><p>景点名称、坐标和来源返回后才进入候选池。</p></div></section>
        <section><Icon name="train"/><div><strong>再计算交通矩阵</strong><p>路线矩阵完成后，DeepSeek V4 Pro 才开始联网核验并安排每日时间轴。</p></div></section>
        <section><Icon name="alert"/><div><strong>预测不冒充实时人数</strong><p>拥挤仅展示风险概率、依据和置信度；预约、远期天气与无来源时令状态可能显示“暂未核验”。</p></div></section>
      </div>
      <div className="agent-live-log"><b>{progress?.title ?? "正在联网获取可验证的旅行数据……"}</b>{items.slice(-5).map((line) => <span key={line}>{line.replaceAll("Unknown", "暂未核验")}</span>)}</div>
    </section>
  </div>;
}
