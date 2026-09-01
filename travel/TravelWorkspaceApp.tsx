"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendItineraryVersion, restoreItineraryVersion } from "../worker/domain/versioning.ts";
import { deterministicProfileHints } from "../worker/domain/profile-extraction.ts";
import type { AgentEvent, AgentState, ItineraryVersion } from "../worker/domain/types.ts";
import { AgentActivity } from "./components/AgentActivity.tsx";
import { ChangePreview } from "./components/ChangePreview.tsx";
import { DataAcquisition } from "./components/DataAcquisition.tsx";
import { EmptyTripHero } from "./components/EmptyTripHero.tsx";
import { ItineraryValidation } from "./components/ItineraryValidation.tsx";
import { Icon } from "./components/Icon.tsx";
import { PersistentChat } from "./components/PersistentChat.tsx";
import { PlanningVisualization } from "./components/PlanningVisualization.tsx";
import { ReadyDashboard } from "./components/ReadyDashboard.tsx";
import { RequirementProfile } from "./components/RequirementProfile.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StageProgress } from "./components/StageProgress.tsx";
import { workspaceRepository } from "./data/localWorkspaceRepository.ts";
import { usePlanningLifecycle } from "./hooks/usePlanningLifecycle.ts";
import { usePlanningProgress } from "./hooks/usePlanningProgress.ts";
import { explainPlan, monitorTrip, runPlanningJob, type PlanningInput } from "./services/planningApi.ts";
import { WORKSPACE_STAGES } from "./state/machine.ts";
import { createWorkspaceId, EMPTY_FORM, isExplanation, profileToForm, REVIEW_LABELS } from "./state/workspace-config.ts";
import type { ComposerMessage, PendingChange, PlanningProgress, TravelFormState, TravelProfile, UiPlan, WorkspaceSnapshot } from "./types.ts";

export function TravelWorkspaceApp() {
  const [id, setId] = useState(createWorkspaceId);
  const [stage, setStage] = useState<AgentState>("EMPTY");
  const [draft, setDraft] = useState("");
  const [form, setForm] = useState<TravelFormState>(EMPTY_FORM);
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
  const [parametersOpen, setParametersOpen] = useState(false);
  const [reviewStep, setReviewStep] = useState(3);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const planningControllerRef = useRef<AbortController | null>(null);
  const monitorEventRef = useRef("");
  const monitoredReplanRef = useRef<(text: string) => Promise<void>>(async () => undefined);

  const activePlan = useMemo(() => plans.find((plan) => plan.id === activePlanId) ?? plans[0] ?? null, [activePlanId, plans]);
  const stageConfig = WORKSPACE_STAGES[stage];
  const { beginProfileStage, clearStageTimers, handleProgress } = usePlanningProgress({ workspaceId: id, setProgress, setProfile, setForm, setEvents, setStage });

  useEffect(() => {
    if (stage === "BUILDING_PROFILE" || (stage === "READY" && reviewStep === 0)) setSidebarCollapsed(false);
  }, [reviewStep, stage]);

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
    draft,
    form,
    messages,
    progress,
    createdAt: workspaces.find((workspace) => workspace.id === id)?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }), [activePlanId, draft, events, form, id, messages, plans, profile, progress, stage, versions, workspaces]);

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
    setForm(stored.form ?? (stored.profile ? profileToForm(stored.profile as TravelProfile) : EMPTY_FORM));
    setPlans(stored.alternatives);
    setActivePlanId(stored.activePlanId);
    setVersions(stored.versions);
    setEvents(stored.events);
    setDraft(stored.draft ?? "");
    setMessages(stored.messages ?? []);
    setProgress(stored.progress ?? null);
    setReviewStep(stored.state === "READY" || stored.state === "EXECUTING" ? 3 : Math.max(0, WORKSPACE_STAGES[stored.state].flow));
    setPendingChange(null);
    setMobileSidebarOpen(false);
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

  useEffect(() => {
    if (!draft.trim()) return;
    const timer = window.setTimeout(() => {
      const hints = deterministicProfileHints(draft);
      setForm((current) => ({
        ...current,
        city: typeof hints.city === "string" ? hints.city : current.city,
        startDate: typeof hints.startDate === "string" ? hints.startDate : current.startDate,
        days: typeof hints.days === "number" ? Math.min(7, Math.max(1, hints.days)) : current.days,
        partySize: typeof hints.partySize === "number" ? hints.partySize : current.partySize,
        preferences: Array.isArray(hints.preferences) ? hints.preferences as string[] : current.preferences,
      }));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const onPopState = () => {
      const pathId = location.pathname.match(/^\/travel\/([^/]+)\/?$/)?.[1];
      if (pathId && pathId !== "index.html") void loadWorkspace(pathId, false);
      else {
        setId(createWorkspaceId()); setStage("EMPTY"); setDraft(""); setForm(EMPTY_FORM);
        setProfile(null); setProgress(null); setPlans([]); setActivePlanId(null);
        setVersions([]); setEvents([]); setMessages([]); setPendingChange(null); setError(null);
        setParametersOpen(false); setReviewStep(3);
      }
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!error || stage !== "READY") return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error, stage]);

  useEffect(() => {
    if (stage !== "READY" || !profile) return;
    const timer = setTimeout(() => {
      void workspaceRepository.get(id).then((stored) => stored ? workspaceRepository.save({ ...stored, draft, form, messages, updatedAt: new Date().toISOString() }) : undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, form, id, messages, profile, stage]);

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
    deepReasoning: form.deepReasoning,
    partySize: form.partySize,
    freeText,
    replanContext,
  }), [form]);

  const savePlanningResult = useCallback(async (result: Awaited<ReturnType<typeof runPlanningJob>>, nextForm: TravelFormState) => {
    await workspaceRepository.save(snapshot({ state: "VALIDATING_ITINERARY", profile: result.request, alternatives: result.alternatives, activePlanId: result.activeId, events: result.agentEvents ?? [], versions: [], draft, form: nextForm, messages, progress: result.progress ?? null }));
    await refreshWorkspaces();
  }, [draft, messages, refreshWorkspaces, snapshot]);

  const { startPlanning, retryPlanning, cancelPlanning, abandonPlanning } = usePlanningLifecycle({
    busy, setBusy, setError, planningControllerRef, draft, form, planningInput, handleProgress, beginProfileStage, clearStageTimers, saveResult: savePlanningResult,
    setDraft, setForm, setProfile, setProgress, setPlans, setActivePlanId, setEvents, setVersions,
    setStage, setParametersOpen, setReviewStep,
  });

  const openWorkspace = async (nextId: string) => {
    if (!await cancelPlanning()) return;
    await loadWorkspace(nextId);
  };

  const enterReady = async (planId: string) => {
    const selected = plans.find((plan) => plan.id === planId);
    if (!selected) return;
    setActivePlanId(planId);
    const nextVersions = versions.length ? versions : appendItineraryVersion([], id, selected, null, "初始方案", "agent");
    setVersions(nextVersions);
    setStage("READY");
    setReviewStep(3);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await persist({ state: "READY", activePlanId: planId, versions: nextVersions, progress });
  };

  const sendComposer = async (text: string, origin: "user" | "monitor" = "user") => {
    const createdAt = new Date().toISOString();
    setMessages((current) => [...current, { id: `${origin}-${Date.now()}`, role: origin === "user" ? "user" : "assistant", text: origin === "user" ? text : `执行监控：${text}`, createdAt }]);
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
    setReviewStep(3);
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
      const controller = new AbortController();
      planningControllerRef.current = controller;
      const result = await runPlanningJob(planningInput(`${draft}\n\n在现有行程基础上执行以下调整，并尽量保持未点名的日期不变：${text}`, context), (next) => setProgress(next), controller.signal);
      const after = result.alternatives.find((plan) => plan.id === activePlan.variant) ?? result.alternatives[0];
      setPendingChange({ before: activePlan, after, result, adjustment: text, changeSet: after.changeSet ?? null });
      setStage("READY");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "局部重规划失败");
      setStage("READY");
    } finally { setBusy(false); }
  };
  monitoredReplanRef.current = (text: string) => sendComposer(text, "monitor");

  useEffect(() => {
    if (stage !== "READY" || reviewStep !== 3 || !activePlan || !profile || busy) return;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (!activePlan.daysPlan.some((day) => day.date === today)) return;
    let cancelled = false;
    const check = async () => {
      try {
        const result = await monitorTrip(activePlan, profile);
        if (cancelled || !result.actionable || !result.adjustment || !result.eventKey || result.eventKey === monitorEventRef.current) return;
        monitorEventRef.current = result.eventKey;
        await monitoredReplanRef.current(result.adjustment);
      } catch { /* 途中监控失败不打断用户查看当前行程 */ }
    };
    void check();
    const timer = setInterval(() => void check(), 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activePlan, busy, profile, reviewStep, stage]);

  const applyPendingChange = async () => {
    if (!pendingChange) return;
    const { result, after, changeSet, adjustment } = pendingChange;
    const nextVersions = appendItineraryVersion(versions, id, after, changeSet, adjustment, "user");
    setPlans(result.alternatives);
    setActivePlanId(after.id);
    setEvents(result.agentEvents ?? events);
    setVersions(nextVersions);
    setPendingChange(null);
    setReviewStep(3);
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

  const newTrip = async () => {
    if (!await cancelPlanning()) return;
    const nextId = createWorkspaceId();
    setId(nextId);
    setStage("EMPTY");
    setDraft("");
    setForm(EMPTY_FORM);
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
    setMobileSidebarOpen(false);
    setParametersOpen(false);
    setReviewStep(3);
    history.pushState({}, "", "/travel/");
  };

  const editRequirements = async () => {
    if (!await cancelPlanning()) return;
    setError(null);
    setStage("EMPTY");
    setParametersOpen(true);
    requestAnimationFrame(() => document.getElementById("inline-parameters-title")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const deleteWorkspace = async (workspaceIdToDelete: string) => {
    await workspaceRepository.remove(workspaceIdToDelete);
    if (workspaceIdToDelete === id && stage !== "EMPTY") await newTrip();
    await refreshWorkspaces();
  };

  const openReviewStep = (step: number) => {
    setReviewStep(step);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  };

  const readyForReview = stage === "READY" && Boolean(activePlan);
  const profileWorkspaceVisible = stage === "BUILDING_PROFILE" || (readyForReview && reviewStep === 0);
  const headerTitle = readyForReview && reviewStep < 3 ? `回看：${REVIEW_LABELS[reviewStep]}` : activePlan && ["READY","EXECUTING"].includes(stage) ? `${activePlan.city} · ${activePlan.days} 天旅行` : stageConfig.title;
  const headerEyebrow = readyForReview && reviewStep < 3 ? `STAGE ${reviewStep + 1} / REVIEW` : stageConfig.eyebrow;
  const headerState = readyForReview && reviewStep < 3 ? "阶段回看" : stageConfig.label;

  return <div className={`app-shell v2-shell react-workspace-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${profileWorkspaceVisible ? " profile-workspace-view" : ""}`}>
    <Sidebar workspaces={workspaces} activeId={stage === "EMPTY" ? null : id} collapsed={sidebarCollapsed} mobileOpen={mobileSidebarOpen} onCloseMobile={() => setMobileSidebarOpen(false)} onToggle={() => setSidebarCollapsed((value) => !value)} onNew={() => void newTrip()} onOpen={(nextId) => void openWorkspace(nextId)} onDelete={(nextId) => void deleteWorkspace(nextId)}/>
    <main className="workspace-canvas react-workspace-canvas">
      <header className="workspace-header"><div className="workspace-title"><button className="mobile-menu-button" type="button" aria-label="打开行程侧栏" onClick={() => setMobileSidebarOpen(true)}><Icon name="menu"/></button><span>{headerEyebrow}</span><strong>{headerTitle}</strong></div><div className="workspace-actions"><span className={`workspace-state${stage === "ERROR" ? " warning" : stage === "EMPTY" ? "" : " live"}`}>{headerState}</span><button type="button" onClick={() => stage === "EMPTY" ? setParametersOpen((value) => !value) : void editRequirements()}>{stage === "EMPTY" && parametersOpen ? "收起参数" : "旅行参数"}</button></div></header>
      {stage !== "EMPTY" && <StageProgress state={stage} selectedStep={readyForReview ? reviewStep : undefined} onSelect={readyForReview ? openReviewStep : undefined}/>}
      {stage === "EMPTY" && <EmptyTripHero value={draft} form={form} busy={busy} onChange={setDraft} onFormChange={setForm} onSubmit={() => void startPlanning()} parametersOpen={parametersOpen} onToggleParameters={() => setParametersOpen((value) => !value)}/>}
      {stage === "BUILDING_PROFILE" && (
        <RequirementProfile request={draft} profile={profile} progress={progress} onEdit={() => void editRequirements()}/>
      )}
      {["FETCHING_DATA","ASSESSING_EVIDENCE"].includes(stage) && (
        <DataAcquisition request={draft} profile={profile} progress={progress} onCancel={() => void cancelPlanning()}/>
      )}
      {stage === "GENERATING_ITINERARY" && <PlanningVisualization profile={profile} progress={progress} plans={plans} onCancel={() => void cancelPlanning()}/>}
      {stage === "VALIDATING_ITINERARY" && (
        <ItineraryValidation plans={plans} profile={profile} activeId={activePlanId ?? plans[0]?.id ?? ""} onSelect={(planId) => void enterReady(planId)}/>
      )}
      {stage === "ERROR" && <section className="error-workspace panel"><Icon name="alert"/><h2>规划任务需要处理</h2><p>{error}</p><div className="error-actions"><button className="secondary-button" type="button" onClick={() => void retryPlanning()}>从检查点继续</button><button className="secondary-button" type="button" onClick={abandonPlanning}>放弃任务</button><button className="primary-button compact" type="button" onClick={() => void startPlanning()}><span>保留输入并新建</span><Icon name="arrow"/></button></div></section>}
      {readyForReview && reviewStep === 0 && <RequirementProfile request={draft} profile={profile} progress={progress} onEdit={() => void editRequirements()}/>}
      {readyForReview && reviewStep === 1 && <DataAcquisition request={draft} profile={profile} progress={progress}/>}
      {readyForReview && reviewStep === 2 && <PlanningVisualization profile={profile} progress={progress} plans={plans}/>}
      {(["EXECUTING","REPLANNING"].includes(stage) || readyForReview && reviewStep === 3) && activePlan && <ReadyDashboard key={activePlan.id} plan={activePlan} plans={plans} events={events} versions={versions} progress={progress} onSelectPlan={(planId) => { setActivePlanId(planId); void persist({ activePlanId: planId }); }} onRestoreVersion={(versionId) => void restoreVersion(versionId)} onOpenReplan={() => document.querySelector<HTMLTextAreaElement>(".react-composer textarea")?.focus()}/>}
      {stage !== "EMPTY" && (!readyForReview || reviewStep === 3) && <PersistentChat busy={busy} messages={messages} onSend={(text) => void sendComposer(text)}/>}
      {events.length > 0 && !["READY","EXECUTING","REPLANNING"].includes(stage) && <AgentActivity events={events}/>} 
    </main>
    {pendingChange && <ChangePreview pending={pendingChange} onApply={() => void applyPendingChange()} onDiscard={() => setPendingChange(null)}/>} 
    {error && stage === "READY" && <div className="react-toast" role="alert"><span>{error}</span><button type="button" aria-label="关闭提示" onClick={() => setError(null)}><Icon name="close"/></button></div>}
  </div>;
}
