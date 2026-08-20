"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { appendItineraryVersion, restoreItineraryVersion } from "../worker/domain/versioning.ts";
import type { AgentEvent, AgentState, ItineraryVersion } from "../worker/domain/types.ts";
import { AgentActivity } from "./components/AgentActivity.tsx";
import { ChangePreview } from "./components/ChangePreview.tsx";
import { DataAcquisition } from "./components/DataAcquisition.tsx";
import { EmptyTripHero } from "./components/EmptyTripHero.tsx";
import { ItineraryValidation } from "./components/ItineraryValidation.tsx";
import { PersistentChat } from "./components/PersistentChat.tsx";
import { ReadyDashboard } from "./components/ReadyDashboard.tsx";
import { RequirementProfile } from "./components/RequirementProfile.tsx";
import { SettingsDrawer } from "./components/SettingsDrawer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StageProgress } from "./components/StageProgress.tsx";
import { workspaceRepository } from "./data/localWorkspaceRepository.ts";
import { explainPlan, runPlanningJob, type PlanningInput } from "./services/planningApi.ts";
import { WORKSPACE_STAGES } from "./state/machine.ts";
import type { ComposerMessage, PendingChange, PlanningProgress, TravelFormState, TravelProfile, UiPlan, WorkspaceSnapshot } from "./types.ts";

function dateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

const DEFAULT_FORM: TravelFormState = {
  city: "杭州",
  // Keep the server and first browser render deterministic. The browser fills a
  // useful near-future default immediately after hydration.
  startDate: "",
  days: 3,
  budget: 2000,
  partySize: 2,
  style: "自然风景",
  preferences: ["自然", "摄影"],
  pace: "medium",
  transport: "公共交通优先",
  hotelPreference: "交通方便",
};

function workspaceId(): string {
  return `trip-${crypto.randomUUID().slice(0, 12)}`;
}

function eventFromProgress(id: string, progress: PlanningProgress): AgentEvent {
  const state: AgentState = progress.phase === "analysis" ? "BUILDING_PROFILE" : progress.phase === "live" ? "FETCHING_DATA" : "GENERATING_ITINERARY";
  return { id: `${id}-${progress.phase}-${Date.now()}`, workspaceId: id, type: progress.phase, state, title: progress.title, detail: progress.items.at(-1), progress: progress.phase === "analysis" ? 18 : progress.phase === "live" ? 42 : 58, createdAt: new Date().toISOString() };
}

function profileToForm(profile: TravelProfile, previous: TravelFormState): TravelFormState {
  return {
    city: profile.city || previous.city,
    startDate: profile.startDate || previous.startDate,
    days: Number(profile.days || previous.days),
    budget: Number(profile.budget || previous.budget),
    partySize: Number(profile.partySize || previous.partySize),
    style: profile.style || previous.style,
    preferences: profile.preferences?.length ? profile.preferences : previous.preferences,
    pace: profile.pace || previous.pace,
    transport: profile.transport || previous.transport,
    hotelPreference: profile.hotelPreference || previous.hotelPreference,
  };
}

function isExplanation(text: string): boolean {
  return /^(为什么|解释|依据|证据|可靠|数据|怎么|哪些未知|风险)/.test(text.trim());
}

export function TravelWorkspaceApp() {
  const [id, setId] = useState(workspaceId);
  const [stage, setStage] = useState<AgentState>("EMPTY");
  const [draft, setDraft] = useState("");
  const [form, setForm] = useState<TravelFormState>(DEFAULT_FORM);
  const [profile, setProfile] = useState<TravelProfile | null>(null);
  const [progress, setProgress] = useState<PlanningProgress | null>(null);
  const [plans, setPlans] = useState<UiPlan[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [versions, setVersions] = useState<ItineraryVersion[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSnapshot[]>([]);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [messages, setMessages] = useState<ComposerMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setForm((current) => current.startDate ? current : { ...current, startDate: dateAfter(14) }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const activePlan = useMemo(() => plans.find((plan) => plan.id === activePlanId) ?? plans[0] ?? null, [activePlanId, plans]);
  const stageConfig = WORKSPACE_STAGES[stage];

  const refreshWorkspaces = useCallback(async () => {
    const stored = await workspaceRepository.list();
    setWorkspaces(stored as WorkspaceSnapshot[]);
  }, []);

  const snapshot = useCallback((overrides?: Partial<WorkspaceSnapshot>): WorkspaceSnapshot => ({
    id,
    title: profile?.city ? `${profile.city} · ${profile.days}日游` : "新旅行",
    state: stage,
    profile,
    alternatives: plans,
    activePlanId,
    versions,
    events,
    pendingChange: null,
    executionFeedback: [],
    createdAt: workspaces.find((workspace) => workspace.id === id)?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }), [activePlanId, events, id, plans, profile, stage, versions, workspaces]);

  const persist = useCallback(async (overrides?: Partial<WorkspaceSnapshot>) => {
    await workspaceRepository.save(snapshot(overrides));
    await refreshWorkspaces();
  }, [refreshWorkspaces, snapshot]);

  const loadWorkspace = useCallback(async (nextId: string, updatePath = true) => {
    const stored = await workspaceRepository.get(nextId) as WorkspaceSnapshot | null;
    if (!stored) return;
    setId(stored.id);
    setStage(stored.state === "EXECUTING" ? "READY" : stored.state);
    setProfile(stored.profile);
    if (stored.profile) setForm((current) => profileToForm(stored.profile as TravelProfile, current));
    setPlans(stored.alternatives);
    setActivePlanId(stored.activePlanId);
    setVersions(stored.versions);
    setEvents(stored.events);
    setDraft("");
    setError(null);
    if (updatePath) history.pushState({}, "", `/travel/${stored.id}`);
  }, []);

  useEffect(() => {
    document.body.dataset.stage = stage;
    document.body.classList.toggle("workspace-focus", stage !== "EMPTY");
    if (stage !== "EMPTY") setSidebarCollapsed(true);
  }, [stage]);

  useEffect(() => {
    void refreshWorkspaces().then(async () => {
      const pathId = location.pathname.match(/^\/travel\/([^/]+)\/?$/)?.[1];
      if (pathId && pathId !== "index.html") await loadWorkspace(pathId, false);
    });
  }, [loadWorkspace, refreshWorkspaces]);

  const planningInput = useCallback((freeText: string, replanContext: PlanningInput["replanContext"] = null): PlanningInput => ({
    city: form.city,
    startDate: form.startDate,
    days: form.days,
    budget: form.budget,
    style: form.style,
    preferences: form.preferences,
    pace: form.pace,
    transport: form.transport,
    hotelPreference: form.hotelPreference,
    partySize: form.partySize,
    freeText,
    replanContext,
  }), [form]);

  const handleProgress = useCallback((next: PlanningProgress) => {
    setProgress(next);
    if (next.formSync) {
      setProfile(next.formSync);
      setForm((current) => profileToForm(next.formSync as TravelProfile, current));
    }
    const event = eventFromProgress(id, next);
    setEvents((current) => current.some((item) => item.type === event.type && item.title === event.title) ? current : [...current, event]);
    if (next.phase === "analysis") setStage("BUILDING_PROFILE");
    if (next.phase === "live") setStage("FETCHING_DATA");
    if (next.phase === "route") setStage("GENERATING_ITINERARY");
  }, [id]);

  const startPlanning = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStage("BUILDING_PROFILE");
    setPlans([]);
    setVersions([]);
    setEvents([]);
    try {
      const result = await runPlanningJob(planningInput(draft), handleProgress);
      setProfile(result.request);
      setForm((current) => profileToForm(result.request, current));
      setPlans(result.alternatives);
      setActivePlanId(result.activeId);
      setEvents(result.agentEvents ?? []);
      setProgress(result.progress ?? null);
      setStage("VALIDATING_ITINERARY");
      await workspaceRepository.save(snapshot({ state: "VALIDATING_ITINERARY", profile: result.request, alternatives: result.alternatives, activePlanId: result.activeId, events: result.agentEvents ?? [], versions: [] }));
      await refreshWorkspaces();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "规划工具暂时不可用");
      setStage("ERROR");
    } finally {
      setBusy(false);
    }
  };

  const enterReady = async (planId: string) => {
    const selected = plans.find((plan) => plan.id === planId);
    if (!selected) return;
    setActivePlanId(planId);
    const nextVersions = versions.length ? versions : appendItineraryVersion([], id, selected, null, "初始方案", "agent");
    setVersions(nextVersions);
    setStage("READY");
    await persist({ state: "READY", activePlanId: planId, versions: nextVersions });
  };

  const sendComposer = async (text: string) => {
    const createdAt = new Date().toISOString();
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", text, createdAt }]);
    if (!activePlan || !profile) return;
    setBusy(true);
    setError(null);
    if (isExplanation(text)) {
      try {
        const answer = await explainPlan(text, activePlan, profile);
        setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", text: answer, createdAt: new Date().toISOString() }]);
      } catch (caught) {
        setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", text: caught instanceof Error ? caught.message : "解释服务暂时不可用", createdAt: new Date().toISOString() }]);
      } finally { setBusy(false); }
      return;
    }
    setStage("REPLANNING");
    try {
      const context = {
        adjustment: text,
        activeVariant: activePlan.variant,
        days: activePlan.daysPlan.map((day) => ({
          day: day.day,
          spotIds: day.items.map((item) => item.id),
          items: day.items.map((item) => ({
            id: item.id, name: item.name, lat: item.lat, lng: item.lng, category: item.category,
            startTime: item.startTime, endTime: item.endTime, durationMin: item.durationMin,
            openingHours: item.openingHours, sourceName: item.sourceName, sourceUrl: item.sourceUrl,
            fetchedAt: item.fetchedAt, requiredByUser: item.requiredByUser,
          })),
        })),
      };
      const result = await runPlanningJob(planningInput(`${draft}\n\n在现有行程基础上执行以下调整，并尽量保持未点名的日期不变：${text}`, context), (next) => setProgress(next));
      const after = result.alternatives.find((plan) => plan.id === activePlan.variant) ?? result.alternatives[0];
      setPendingChange({ before: activePlan, after, result, adjustment: text, changeSet: after.changeSet ?? null });
      setStage("READY");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "局部重规划失败");
      setStage("READY");
    } finally { setBusy(false); }
  };

  const applyPendingChange = async () => {
    if (!pendingChange) return;
    const { result, after, changeSet, adjustment } = pendingChange;
    const nextVersions = appendItineraryVersion(versions, id, after, changeSet, adjustment, "user");
    setPlans(result.alternatives);
    setActivePlanId(after.id);
    setEvents(result.agentEvents ?? events);
    setVersions(nextVersions);
    setPendingChange(null);
    setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", text: `已按最小扰动原则保存 Version ${nextVersions.length}；未受影响日期保持原方案。`, createdAt: new Date().toISOString() }]);
    await persist({ state: "READY", alternatives: result.alternatives, activePlanId: after.id, events: result.agentEvents ?? events, versions: nextVersions });
  };

  const restoreVersion = async (versionId: string) => {
    const restored = restoreItineraryVersion(versions, versionId);
    if (!restored) return;
    const nextPlans = [restored.plan as UiPlan, ...plans.filter((plan) => plan.id !== restored.plan.id)];
    setPlans(nextPlans);
    setActivePlanId(restored.plan.id);
    await persist({ alternatives: nextPlans, activePlanId: restored.plan.id });
  };

  const newTrip = () => {
    const nextId = workspaceId();
    setId(nextId);
    setStage("EMPTY");
    setDraft("");
    setProfile(null);
    setProgress(null);
    setPlans([]);
    setActivePlanId(null);
    setVersions([]);
    setEvents([]);
    setMessages([]);
    setPendingChange(null);
    setError(null);
    setSidebarCollapsed(false);
    history.pushState({}, "", "/travel/");
  };

  return <div className={`app-shell v2-shell react-workspace-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <Sidebar workspaces={workspaces} activeId={stage === "EMPTY" ? null : id} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} onNew={newTrip} onOpen={(nextId) => void loadWorkspace(nextId)}/>
    <main className="workspace-canvas react-workspace-canvas">
      <header className="workspace-header"><div className="workspace-title"><span>{stageConfig.eyebrow}</span><strong>{activePlan && ["READY","EXECUTING"].includes(stage) ? `${activePlan.city} · ${activePlan.days} 天旅行` : stageConfig.title}</strong></div><div className="workspace-actions"><span className={`workspace-state${stage === "ERROR" ? " warning" : stage === "EMPTY" ? "" : " live"}`}>{stageConfig.label}</span><button type="button" onClick={() => setSettingsOpen(true)}>旅行参数</button></div></header>
      {stage !== "EMPTY" && <StageProgress state={stage}/>} 
      {stage === "EMPTY" && <EmptyTripHero value={draft} form={form} busy={busy} onChange={setDraft} onSubmit={() => void startPlanning()} onOpenSettings={() => setSettingsOpen(true)}/>} 
      {stage === "BUILDING_PROFILE" && <RequirementProfile request={draft} profile={profile} progress={progress}/>} 
      {["FETCHING_DATA","ASSESSING_EVIDENCE","GENERATING_ITINERARY"].includes(stage) && <DataAcquisition request={draft} profile={profile} progress={progress}/>} 
      {stage === "VALIDATING_ITINERARY" && <ItineraryValidation plans={plans} activeId={activePlanId ?? plans[0]?.id ?? ""} onSelect={(planId) => void enterReady(planId)}/>} 
      {stage === "ERROR" && <section className="error-workspace panel"><span>!</span><h2>规划工具暂时不可用</h2><p>{error}</p><button className="primary-button compact" type="button" onClick={() => void startPlanning()}><span>保留输入并重试</span><b>↻</b></button></section>} 
      {["READY","EXECUTING","REPLANNING"].includes(stage) && activePlan && <ReadyDashboard plan={activePlan} plans={plans} events={events} versions={versions} onSelectPlan={(planId) => { setActivePlanId(planId); void persist({ activePlanId: planId }); }} onRestoreVersion={(versionId) => void restoreVersion(versionId)} onOpenReplan={() => document.querySelector<HTMLInputElement>(".react-composer input")?.focus()}/>} 
      {stage !== "EMPTY" && <PersistentChat busy={busy} messages={messages} onSend={(text) => void sendComposer(text)}/>} 
      {events.length > 0 && !["READY","EXECUTING","REPLANNING"].includes(stage) && <AgentActivity events={events}/>} 
    </main>
    <SettingsDrawer open={settingsOpen} form={form} onChange={setForm} onClose={() => setSettingsOpen(false)}/>
    {pendingChange && <ChangePreview pending={pendingChange} onApply={() => void applyPendingChange()} onDiscard={() => setPendingChange(null)}/>} 
    {error && stage === "READY" && <div className="react-toast">{error}</div>}
  </div>;
}
