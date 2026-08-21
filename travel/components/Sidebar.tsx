"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  workspaces: WorkspaceSnapshot[];
  activeId: string | null;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onCloseMobile: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
}

function chinaDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function groupLabel(workspace: WorkspaceSnapshot): "旅行中" | "即将出发" | "未开始" | "已结束" {
  const today = chinaDate();
  const start = workspace.profile?.startDate ?? "";
  if (!start) return "未开始";
  const end = new Date(`${start}T00:00:00+08:00`);
  end.setDate(end.getDate() + Math.max(0, (workspace.profile?.days ?? 1) - 1));
  if (chinaDate(end) < today) return "已结束";
  if (start <= today) return "旅行中";
  const daysAway = Math.ceil((new Date(`${start}T00:00:00+08:00`).getTime() - new Date(`${today}T00:00:00+08:00`).getTime()) / 86_400_000);
  return daysAway <= 30 ? "即将出发" : "未开始";
}

export function Sidebar({ workspaces, activeId, collapsed, mobileOpen, onToggle, onCloseMobile, onNew, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = ["旅行中", "即将出发", "未开始", "已结束"] as const;
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    if (!term) return workspaces;
    return workspaces.filter((workspace) => {
      const haystack = [workspace.title, workspace.profile?.city, workspace.profile?.startDate].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
      return haystack.includes(term);
    });
  }, [query, workspaces]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && mobileOpen) onCloseMobile();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [mobileOpen, onCloseMobile]);

  const openWorkspace = (workspaceId: string) => {
    onOpen(workspaceId);
    onCloseMobile();
  };
  const createTrip = () => {
    onNew();
    onCloseMobile();
  };

  return <>
    <aside className={`travel-sidebar react-sidebar${collapsed ? " is-collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`} aria-label="旅行工作区导航">
      <a className="brand sidebar-brand" href="/travel/" aria-label="智能旅游助手首页">
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M8.7 26.8 40 9.2 32 40l-8.6-10-11 8.1 3.1-14.2-6.8 2.9Z"/><path className="brand-path" d="m20 22.5 9.2 7.4"/></svg></span>
        <span className="sidebar-label"><b>智能旅游助手</b><small>AI TRAVEL ASSISTANT</small></span>
      </a>
      <button className="sidebar-collapse" onClick={onToggle} type="button" aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}><Icon name={collapsed ? "chevronRight" : "chevronLeft"}/></button>
      <button className="sidebar-new-trip" onClick={createTrip} type="button"><Icon name="plus"/><span className="sidebar-label">新建旅行</span></button>
      <label className="sidebar-search"><Icon name="search"/><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索旅行" aria-label="搜索旅行"/><kbd><span className="shortcut-mac">⌘</span><span className="shortcut-win">Ctrl</span> K</kbd></label>
      <section className="sidebar-history" aria-label="旅行列表">
        {!workspaces.length ? <div className="sidebar-empty"><Icon name="mapPin"/><b>还没有旅行</b><span>创建第一段旅程后，它会出现在这里。</span></div> : !filtered.length ? <div className="sidebar-empty compact"><Icon name="search"/><b>没有匹配的旅行</b><span>换个城市或日期试试。</span></div> :
          <div className="trip-history-groups">{groups.map((group) => {
            const rows = filtered.filter((workspace) => groupLabel(workspace) === group);
            if (!rows.length) return null;
            return <section className="trip-history-group" key={group}>
              <header><span>{group}</span><b>{rows.length}</b></header>
              <div>{rows.map((workspace) => <button
                className={`history-item${workspace.id === activeId ? " active" : ""}`}
                key={workspace.id}
                type="button"
                onClick={() => openWorkspace(workspace.id)}
              ><i></i><span><b>{workspace.profile?.city ?? "未命名"} · {workspace.profile?.days ?? "?"}天</b><small>{workspace.profile?.startDate ?? "日期未定"} · {workspace.state === "READY" ? "规划完成" : "进行中"}</small></span></button>)}</div>
            </section>;
          })}</div>}
      </section>
      <div className="sidebar-footer">
        <div className="sidebar-user"><span className="user-avatar"><Icon name="sparkles"/></span><div className="sidebar-label"><b>本地工作区</b><small>旅行数据保存在此浏览器</small></div></div>
      </div>
    </aside>
    {mobileOpen ? <button className="mobile-sidebar-backdrop" type="button" aria-label="关闭旅行列表" onClick={onCloseMobile}/> : null}
  </>;
}
