import type { PlanningProgress, PlanningResult, TravelProfile, UiPlan } from "../types.ts";

interface ErrorEnvelope { error?: { message?: string } | string }

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({ error: { message: "服务返回的内容不是 JSON" } })) as T & ErrorEnvelope;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message || `服务请求失败（HTTP ${response.status}）`);
  }
  return body;
}

export interface PlanningInput {
  city: string;
  startDate: string;
  days: number;
  budget: number;
  style: string;
  preferences: string[];
  pace: string;
  transport: string;
  hotelPreference: string;
  freeText: string;
  partySize?: number;
  replanContext?: {
    adjustment: string;
    activeVariant: string;
    days: Array<{
      day: number;
      spotIds: string[];
      items: Array<{
        id: string;
        name: string;
        lat?: number;
        lng?: number;
        category?: string;
        startTime?: string;
        endTime?: string;
        durationMin?: number;
        openingHours?: string | null;
        sourceName?: string;
        sourceUrl?: string | null;
        fetchedAt?: string;
        requiredByUser?: boolean;
      }>;
    }>;
  } | null;
}

interface StartResponse {
  jobId: string;
  status: "working";
  progress: PlanningProgress;
}

type StatusResponse =
  | { status: "working"; progress: PlanningProgress }
  | { status: "done"; result: PlanningResult; progress?: PlanningProgress }
  | { status: "error"; error: { message?: string } };

export async function runPlanningJob(
  input: PlanningInput,
  onProgress: (progress: PlanningProgress) => void,
): Promise<PlanningResult> {
  const started = await requestJson<StartResponse>("/api/plan/start", { method: "POST", body: JSON.stringify(input) });
  onProgress(started.progress);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const status = await requestJson<StatusResponse>(`/api/plan/status?id=${encodeURIComponent(started.jobId)}`);
    if (status.status === "working") {
      onProgress(status.progress);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      continue;
    }
    if (status.status === "done") return status.result;
    throw new Error(status.error.message || "规划任务没有完成");
  }
  throw new Error("规划任务等待超时，请重试");
}

export async function explainPlan(prompt: string, plan: UiPlan, profile: TravelProfile): Promise<string> {
  const context = {
    profile,
    title: plan.title,
    compiler: plan.compiler,
    criticalPath: plan.criticalPath,
    minimumVerification: plan.minimumVerification,
    days: plan.daysPlan.map((day) => ({
      day: day.day,
      date: day.date,
      attractions: day.items.map((item) => ({ name: item.name, time: `${item.startTime ?? "?"}-${item.endTime ?? "?"}` })),
    })),
  };
  const body = await requestJson<{ message: string }>("/api/agent", { method: "POST", body: JSON.stringify({ prompt, context }) });
  return body.message;
}

export async function loadProviders(): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>("/api/providers/status");
}
