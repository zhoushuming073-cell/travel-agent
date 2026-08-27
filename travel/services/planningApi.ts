import type { PlanningProgress, PlanningResult, TravelProfile, UiPlan } from "../types.ts";

interface ErrorEnvelope { error?: { message?: string } | string }

function waitWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const cancel = () => { window.clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new DOMException("Aborted", "AbortError")); };
    const timer = window.setTimeout(finish, milliseconds);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

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
  deepReasoning: boolean;
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
  signal?: AbortSignal,
): Promise<PlanningResult> {
  const idempotencyKey = crypto.randomUUID();
  const jobToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const jobHeaders = { "x-idempotency-key": idempotencyKey, "x-travel-job-token": jobToken };
  const started = await requestJson<StartResponse>("/api/plan/start", { method: "POST", body: JSON.stringify(input), headers: jobHeaders, signal });
  onProgress(started.progress);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await requestJson<StatusResponse>(`/api/plan/status?id=${encodeURIComponent(started.jobId)}`, { headers: { "x-travel-job-token": jobToken }, signal });
    if (status.status === "working") {
      onProgress(status.progress);
      await waitWithSignal(1500, signal);
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

export interface ExecutionMonitorResult {
  active: boolean;
  actionable: boolean;
  checkedAt: string;
  eventKey?: string;
  adjustment?: string;
  note?: string;
  triggers?: Array<{ code: string; severity: string; subject: string; reason: string; action: string; sourceUrl?: string | null }>;
}

export async function monitorTrip(plan: UiPlan, profile: TravelProfile): Promise<ExecutionMonitorResult> {
  const compactPlan = {
    city: plan.city,
    daysPlan: plan.daysPlan.map((day) => ({
      day: day.day, date: day.date,
      items: day.items.map((item) => ({ id: item.id, name: item.name, lat: item.lat, lng: item.lng, startTime: item.startTime, endTime: item.endTime })),
      blocks: day.blocks?.filter((block) => block.type === "leg").map((block) => ({ type: block.type, from: block.from, to: block.to, durationMin: block.durationMin })) ?? [],
    })),
  };
  return requestJson<ExecutionMonitorResult>("/api/monitor", { method: "POST", body: JSON.stringify({ profile, plan: compactPlan }) });
}

export interface ProviderRuntimeStatus {
  provider: string;
  status: "healthy" | "degraded" | "unavailable" | "unknown";
  latencyMs?: number | null;
  totalRequests?: number;
  successCount?: number;
  failureCount?: number;
  rateLimitedCount?: number;
  cacheHits?: number;
  updatedAt?: string;
}

export interface ProviderStatusResponse {
  providers: ProviderRuntimeStatus[];
  metrics: { persistence?: string; activeJobs?: number; cacheEntries?: number; cacheHits?: number; requests24h?: number };
  note?: string;
}

export async function loadProviders(): Promise<ProviderStatusResponse> {
  return requestJson<ProviderStatusResponse>("/api/providers/status");
}
