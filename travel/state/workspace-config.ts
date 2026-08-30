import type { AgentEvent, AgentState } from "../../worker/domain/types.ts";
import type { PlanningProgress, TravelFormState, TravelProfile } from "../types.ts";

export const EMPTY_FORM: TravelFormState = {
  city: "",
  startDate: "",
  days: 3,
  budget: 0,
  partySize: 2,
  style: "",
  preferences: [],
  pace: "medium",
  transport: "公共交通优先",
  hotelPreference: "",
  deepReasoning: true,
};

export const REVIEW_LABELS = ["理解需求", "信息搜集", "智能规划", "方案呈现"] as const;

export function createWorkspaceId(): string {
  return `trip-${crypto.randomUUID().slice(0, 12)}`;
}

export function eventFromProgress(id: string, progress: PlanningProgress): AgentEvent {
  const state: AgentState = progress.phase === "analysis" ? "BUILDING_PROFILE" : progress.phase === "live" ? "FETCHING_DATA" : "GENERATING_ITINERARY";
  return { id: `${id}-${progress.phase}-${Date.now()}`, workspaceId: id, type: progress.phase, state, title: progress.title, detail: progress.items.at(-1), createdAt: new Date().toISOString() };
}

export function profileToForm(profile: TravelProfile, fallback: TravelFormState = EMPTY_FORM): TravelFormState {
  return {
    city: profile.city ?? fallback.city,
    startDate: profile.startDate ?? fallback.startDate,
    days: Number(profile.days ?? fallback.days),
    budget: Number(profile.budget ?? fallback.budget),
    partySize: Number(profile.partySize ?? fallback.partySize),
    style: profile.style ?? fallback.style,
    preferences: profile.preferences ?? fallback.preferences,
    pace: profile.pace ?? fallback.pace,
    transport: profile.transport ?? fallback.transport,
    hotelPreference: profile.hotelPreference ?? fallback.hotelPreference,
    deepReasoning: profile.deepReasoning ?? fallback.deepReasoning,
  };
}

export function isExplanation(text: string): boolean {
  return /^(为什么|解释|依据|证据|可靠|数据|怎么|哪些未知|风险)/.test(text.trim());
}
