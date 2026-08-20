"use client";

import type { WorkspaceSnapshot } from "../types.ts";

interface Props {
  workspaces: WorkspaceSnapshot[];
  activeId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
}

function groupLabel(workspace: WorkspaceSnapshot): "旅行中" | "即将出发" | "未开始" | "已结束" {
  const today = new Date().toISOString().slice(0, 10);
  const start = workspace.profile?.startDate ?? "";
  if (!start) return "未开始";
  const end = new Date(`${start}T00:00:00`);
  end.setDate(end.getDate() + Math.max(0, (workspace.profile?.days ?? 1) - 1));
  if (end.toISOString().slice(0, 10) < today) return "已结束";
  if (start <= today) return "旅行中";
  const daysAway = Math.ceil((new Date(`${start}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000);
  return daysAway <= 30 ? "即将出发" : "未开始";
}

export function Sidebar({ workspaces, activeId, collapsed, onToggle, onNew, onOpen }: Props) {
  const groups = ["旅行中", "即将出发", "未开始", "已结束"] as const;
  return (
    <aside className={`travel-sidebar react-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="旅行工作区导航">
      <a className="brand sidebar-brand" href="/travel/" aria-label="智能旅游助手首页">
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M8.7 26.8 40 9.2 32 40l-8.6-10-11 8.1 3.1-14.2-6.8 2.9Z"/><path className="brand-path" d="m20 22.5 9.2 7.4"/></svg></span>
        <span className="sidebar-label"><b>智能旅游助手</b><small>AI TRAVEL ASSISTANT</small></span>
      </a>
      <button className="sidebar-collapse" onClick={onToggle} type="button" aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? "›" : "‹"}</button>
      <button className="sidebar-new-trip" onClick={onNew} type="button"><span>＋</span><span className="sidebar-label">新建旅行</span></button>
      <label className="sidebar-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="搜索旅行" aria-label="搜索旅行"/><kbd>⌘K</kbd></label>
      <section className="sidebar-history" aria-label="旅行列表">
        <div className="trip-history-groups">
          {groups.map((group) => {
            const rows = workspaces.filter((workspace) => groupLabel(workspace) === group);
            return <section className="trip-history-group" key={group}>
              <header><span>{group}</span><b>{rows.length}</b></header>
              <div>{rows.length ? rows.slice(0, 5).map((workspace) => <button
                className={`history-item${workspace.id === activeId ? " active" : ""}`}
                key={workspace.id}
                type="button"
                onClick={() => onOpen(workspace.id)}
              ><i></i><span><b>{workspace.profile?.city ?? "未命名"} · {workspace.profile?.days ?? "?"}天</b><small>{workspace.profile?.startDate ?? "日期未定"} · {workspace.state === "READY" ? "规划完成" : "进行中"}</small></span><em>⋮</em></button>) : <small className="history-group-empty">暂无</small>}</div>
            </section>;
          })}
        </div>
      </section>
      <div className="sidebar-footer">
        <div className="sidebar-user"><span className="user-avatar">周</span><div className="sidebar-label"><b>周树铭 <em>PRO</em></b><small>DeepSeek · 真实工具链</small></div><span className="status-dot ok"></span></div>
        <button type="button"><span>⚙</span><span className="sidebar-label">设置</span><b>›</b></button>
      </div>
    </aside>
  );
}
