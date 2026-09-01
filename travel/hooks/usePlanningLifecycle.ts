"use client";

import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AgentEvent, AgentState, ItineraryVersion } from "../../worker/domain/types.ts";
import { abandonPlanningJob, cancelPlanningJob, reconnectPlanningJob, retryPlanningJob, runPlanningJob, type PlanningInput } from "../services/planningApi.ts";
import { profileToForm } from "../state/workspace-config.ts";
import type { PlanningProgress, TravelFormState, TravelProfile, UiPlan } from "../types.ts";

type PlanningResult = Awaited<ReturnType<typeof runPlanningJob>>;

interface Options {
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  planningControllerRef: MutableRefObject<AbortController | null>;
  draft: string;
  form: TravelFormState;
  planningInput: (freeText: string, replanContext?: PlanningInput["replanContext"]) => PlanningInput;
  handleProgress: (progress: PlanningProgress) => void;
  beginProfileStage: () => void;
  clearStageTimers: () => void;
  saveResult: (result: PlanningResult, nextForm: TravelFormState) => Promise<void>;
  setDraft: Dispatch<SetStateAction<string>>;
  setForm: Dispatch<SetStateAction<TravelFormState>>;
  setProfile: Dispatch<SetStateAction<TravelProfile | null>>;
  setProgress: Dispatch<SetStateAction<PlanningProgress | null>>;
  setPlans: Dispatch<SetStateAction<UiPlan[]>>;
  setActivePlanId: Dispatch<SetStateAction<string | null>>;
  setEvents: Dispatch<SetStateAction<AgentEvent[]>>;
  setVersions: Dispatch<SetStateAction<ItineraryVersion[]>>;
  setStage: Dispatch<SetStateAction<AgentState>>;
  setParametersOpen: Dispatch<SetStateAction<boolean>>;
  setReviewStep: Dispatch<SetStateAction<number>>;
}

interface PlanningLifecycle {
  startPlanning: () => Promise<void>;
  retryPlanning: () => Promise<void>;
  cancelPlanning: () => Promise<boolean>;
  abandonPlanning: () => void;
}

export function usePlanningLifecycle(options: Options): PlanningLifecycle {
  const {
    busy, setBusy, setError, planningControllerRef,
    draft, form, planningInput, handleProgress, beginProfileStage, clearStageTimers, saveResult,
    setDraft, setForm, setProfile, setProgress, setPlans, setActivePlanId, setEvents, setVersions,
    setStage, setParametersOpen, setReviewStep,
  } = options;
  const applyPlanningResult = useCallback(async (result: PlanningResult) => {
    clearStageTimers();
    const nextForm = profileToForm(result.request, form);
    setProfile(result.request);
    setForm(nextForm);
    setPlans(result.alternatives);
    setActivePlanId(result.activeId);
    setEvents(result.agentEvents ?? []);
    setProgress(result.progress ?? null);
    setStage("VALIDATING_ITINERARY");
    await saveResult(result, nextForm);
  }, [clearStageTimers, form, saveResult, setActivePlanId, setEvents, setForm, setPlans, setProfile, setProgress, setStage]);

  const reconnectPlanning = useCallback(async (quiet = false) => {
    if (busy) return;
    setBusy(true);
    if (!quiet) setError(null);
    const controller = new AbortController();
    planningControllerRef.current = controller;
    try {
      const resumed = await reconnectPlanningJob(handleProgress, controller.signal);
      if (!resumed) {
        if (!quiet) setError("没有可重新连接的后台规划任务");
        return;
      }
      if (resumed.input.freeText) setDraft(resumed.input.freeText);
      await applyPlanningResult(resumed.result);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError") && !quiet) {
        setError(caught instanceof Error ? caught.message : "重新连接任务失败");
        setStage("ERROR");
      }
    } finally {
      setBusy(false);
      if (planningControllerRef.current === controller) planningControllerRef.current = null;
    }
  }, [applyPlanningResult, busy, handleProgress, planningControllerRef, setBusy, setDraft, setError, setStage]);

  const retryPlanning = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStage("GENERATING_ITINERARY");
    const controller = new AbortController();
    planningControllerRef.current = controller;
    try {
      const resumed = await retryPlanningJob(handleProgress, controller.signal);
      if (resumed.input.freeText) setDraft(resumed.input.freeText);
      await applyPlanningResult(resumed.result);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "从检查点继续失败");
        setStage("ERROR");
      }
    } finally {
      setBusy(false);
      if (planningControllerRef.current === controller) planningControllerRef.current = null;
    }
  }, [applyPlanningResult, busy, handleProgress, planningControllerRef, setBusy, setDraft, setError, setStage]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void reconnectPlanning(true); }, 250);
    return () => window.clearTimeout(timer);
  // only attempt automatic cookie/session recovery once after mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPlanning = useCallback(async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    beginProfileStage();
    setStage("BUILDING_PROFILE");
    setParametersOpen(false);
    setReviewStep(0);
    setPlans([]);
    setActivePlanId(null);
    setVersions([]);
    setEvents([]);
    planningControllerRef.current?.abort();
    const controller = new AbortController();
    planningControllerRef.current = controller;
    try {
      const result = await runPlanningJob(planningInput(draft), handleProgress, controller.signal);
      await applyPlanningResult(result);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setStage("EMPTY");
        setProgress(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : "规划工具暂时不可用");
      setStage("ERROR");
    } finally {
      setBusy(false);
      if (planningControllerRef.current === controller) planningControllerRef.current = null;
    }
  }, [applyPlanningResult, beginProfileStage, busy, draft, handleProgress, planningControllerRef, planningInput, setActivePlanId, setBusy, setError, setEvents, setParametersOpen, setPlans, setProgress, setReviewStep, setStage, setVersions]);

  const cancelPlanning = useCallback(async () => {
    planningControllerRef.current?.abort();
    try { await cancelPlanningJob(); } catch (caught) { setError(caught instanceof Error ? caught.message : "服务端取消失败"); return false; }
    clearStageTimers();
    setBusy(false);
    setProgress(null);
    setStage("EMPTY");
    setParametersOpen(true);
    return true;
  }, [clearStageTimers, planningControllerRef, setBusy, setError, setParametersOpen, setProgress, setStage]);

  const abandonPlanning = useCallback(() => {
    planningControllerRef.current?.abort();
    clearStageTimers();
    abandonPlanningJob();
    setBusy(false);
    setProgress(null);
    setStage("EMPTY");
    setParametersOpen(true);
    setError(null);
  }, [clearStageTimers, planningControllerRef, setBusy, setError, setParametersOpen, setProgress, setStage]);

  return { startPlanning, retryPlanning, cancelPlanning, abandonPlanning };
}
