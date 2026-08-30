"use client";

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { AgentEvent, AgentState } from "../../worker/domain/types.ts";
import { eventFromProgress, profileToForm } from "../state/workspace-config.ts";
import type { PlanningProgress, TravelFormState, TravelProfile } from "../types.ts";

interface Options {
  workspaceId: string;
  setProgress: Dispatch<SetStateAction<PlanningProgress | null>>;
  setProfile: Dispatch<SetStateAction<TravelProfile | null>>;
  setForm: Dispatch<SetStateAction<TravelFormState>>;
  setEvents: Dispatch<SetStateAction<AgentEvent[]>>;
  setStage: Dispatch<SetStateAction<AgentState>>;
}

export function usePlanningProgress({ workspaceId, setProgress, setProfile, setForm, setEvents, setStage }: Options) {
  const profileStageStartedAt = useRef(0);
  const profileAdvanceTimer = useRef<number | null>(null);
  const researchAdvanceTimer = useRef<number | null>(null);

  const clearStageTimers = useCallback(() => {
    if (profileAdvanceTimer.current !== null) window.clearTimeout(profileAdvanceTimer.current);
    if (researchAdvanceTimer.current !== null) window.clearTimeout(researchAdvanceTimer.current);
    profileAdvanceTimer.current = null;
    researchAdvanceTimer.current = null;
  }, []);

  useEffect(() => clearStageTimers, [clearStageTimers]);

  const beginProfileStage = useCallback(() => {
    clearStageTimers();
    profileStageStartedAt.current = performance.now();
  }, [clearStageTimers]);

  const handleProgress = useCallback((next: PlanningProgress) => {
    setProgress(next);
    if (next.formSync) {
      setProfile(next.formSync);
      setForm((current) => profileToForm(next.formSync as TravelProfile, current));
    }
    const event = eventFromProgress(workspaceId, next);
    setEvents((current) => current.some((item) => item.type === event.type && item.title === event.title) ? current : [...current, event]);
    if (next.phase === "analysis") setStage("BUILDING_PROFILE");
    if (next.phase === "live") {
      const remaining = Math.max(0, 4200 - (performance.now() - profileStageStartedAt.current));
      if (profileAdvanceTimer.current !== null) window.clearTimeout(profileAdvanceTimer.current);
      profileAdvanceTimer.current = window.setTimeout(() => {
        setStage("FETCHING_DATA");
        profileAdvanceTimer.current = null;
      }, remaining);
    }
    if (next.phase === "route") {
      const remaining = Math.max(0, 4200 - (performance.now() - profileStageStartedAt.current));
      if (remaining > 0) {
        if (profileAdvanceTimer.current !== null) window.clearTimeout(profileAdvanceTimer.current);
        profileAdvanceTimer.current = window.setTimeout(() => {
          setStage("FETCHING_DATA");
          profileAdvanceTimer.current = null;
          researchAdvanceTimer.current = window.setTimeout(() => {
            setStage("GENERATING_ITINERARY");
            researchAdvanceTimer.current = null;
          }, 2200);
        }, remaining);
      } else {
        setStage("GENERATING_ITINERARY");
      }
    }
  }, [setEvents, setForm, setProfile, setProgress, setStage, workspaceId]);

  return { beginProfileStage, clearStageTimers, handleProgress };
}
