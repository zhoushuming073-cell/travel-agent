import type { PlanningProgress, PlanningResult, TravelProfile, UiPlan } from "../types.ts";

interface ErrorEnvelope { error?: { message?: string; code?: string; jobId?: string } | string }

class PlanningRequestError extends Error {
  code?: string;
  jobId?: string;
  status: number;
  constructor(message: string, status: number, code?: string, jobId?: string) {
    super(message);
    this.name = "PlanningRequestError";
    this.status = status;
    this.code = code;
    this.jobId = jobId;
  }
}

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
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({ error: { message: "服务返回的内容不是 JSON" } })) as T & ErrorEnvelope;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const code = typeof body.error === "object" ? body.error?.code : undefined;
    const jobId = typeof body.error === "object" ? body.error?.jobId : undefined;
    throw new PlanningRequestError(message || `服务请求失败（HTTP ${response.status}）`, response.status, code, jobId);
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
  status: "queued" | "working";
  progress: PlanningProgress;
}

type StatusResponse =
  | { jobId: string; status: "queued" | "working" | "needs_input"; progress: PlanningProgress; currentStep?: string; heartbeatAt?: string }
  | { jobId: string; status: "done"; result: PlanningResult; progress?: PlanningProgress }
  | { jobId: string; status: "error" | "cancelled"; error: { message?: string; code?: string }; progress?: PlanningProgress };

interface AdvanceResponse {
  status: "queued" | "working" | "needs_input" | "done" | "error" | "cancelled";
  progress?: PlanningProgress;
  retryable?: boolean;
  retryAfterMs?: number;
}

const ACTIVE_JOB_KEY = "smart-travel-active-job-v29";
interface StoredJob { jobId: string; input: PlanningInput; createdAt: number; progress?: PlanningProgress; workspaceId?: string }

function readStoredJob(): StoredJob | null {
  try { return JSON.parse(sessionStorage.getItem(ACTIVE_JOB_KEY) || "null") as StoredJob | null; } catch { return null; }
}

function writeStoredJob(value: StoredJob | null) {
  try {
    if (value) sessionStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(ACTIVE_JOB_KEY);
  } catch { /* session storage is a convenience, not authority */ }
}

async function pollPlanningJob(jobId: string, input: PlanningInput, onProgress: (progress: PlanningProgress) => void, signal?: AbortSignal): Promise<PlanningResult> {
  let transientFailures = 0;
  let advanceFailures = 0;
  let advanceInFlight: Promise<void> | null = null;
  let advanceFailure: unknown = null;
  let retryNotBefore = 0;
  const launchNextStage = () => {
    advanceInFlight = requestJson<AdvanceResponse>("/api/plan/advance", { method: "POST", body: JSON.stringify({ jobId }), signal })
      .then((advanced) => {
        advanceFailures = 0;
        if (advanced.progress) {
          onProgress(advanced.progress);
          const stored = readStoredJob();
          writeStoredJob({ jobId, input, createdAt: stored?.createdAt || Date.now(), progress: advanced.progress, workspaceId: stored?.workspaceId });
        }
        if (advanced.retryAfterMs) retryNotBefore = Date.now() + advanced.retryAfterMs;
      })
      .catch((error) => { advanceFailure = error; })
      .finally(() => { advanceInFlight = null; });
  };
  for (let attempt = 0; attempt < 650; attempt += 1) {
    try {
      const status = await requestJson<StatusResponse>(`/api/plan/status?id=${encodeURIComponent(jobId)}`, { signal });
      transientFailures = 0;
      if (status.progress) {
        onProgress(status.progress);
        const stored = readStoredJob();
        writeStoredJob({ jobId, input, createdAt: stored?.createdAt || Date.now(), progress: status.progress, workspaceId: stored?.workspaceId });
      }
      if (status.status === "queued" || status.status === "working") {
        if (advanceFailure) {
          const failure = advanceFailure;
          advanceFailure = null;
          if (failure instanceof DOMException && failure.name === "AbortError") throw failure;
          advanceFailures += 1;
          if (advanceFailures > 10) throw failure;
          retryNotBefore = Date.now() + Math.max(10_000, Math.min(30_000, 3000 * advanceFailures));
        }
        if (!advanceInFlight && Date.now() >= retryNotBefore) launchNextStage();
        await waitWithSignal(1800, signal);
        continue;
      }
      if (status.status === "done") {
        writeStoredJob(null);
        return status.result;
      }
      if (status.status === "needs_input") { const error = new Error(status.progress?.items?.[0] || "需要补充旅行信息"); error.name = "PlanningTerminalError"; throw error; }
      writeStoredJob(null);
      const terminalStatus = status as Extract<StatusResponse, { status: "error" | "cancelled" }>;
      const terminal = new Error(terminalStatus.error.message || (terminalStatus.status === "cancelled" ? "规划任务已取消" : "规划任务没有完成"));
      terminal.name = "PlanningTerminalError";
      throw terminal;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof Error && error.name === "PlanningTerminalError") throw error;
      transientFailures += 1;
      if (transientFailures > 10) throw error;
      await waitWithSignal(Math.min(12_000, 1200 * transientFailures), signal);
    }
  }
  throw new Error("规划任务连续运行约 20 分钟仍未完成，已保留全部检查点；刷新页面可继续或取消任务");
}

export async function runPlanningJob(
  input: PlanningInput,
  onProgress: (progress: PlanningProgress) => void,
  signal?: AbortSignal,
  workspaceId?: string,
): Promise<PlanningResult> {
  const idempotencyKey = crypto.randomUUID();
  const jobHeaders = { "x-idempotency-key": idempotencyKey };
  let started: StartResponse;
  try {
    started = await requestJson<StartResponse>("/api/plan/start", { method: "POST", body: JSON.stringify(input), headers: jobHeaders, signal });
  } catch (error) {
    if (error instanceof PlanningRequestError && error.code === "CONCURRENT_JOB_LIMIT" && error.jobId) {
      writeStoredJob({ jobId: error.jobId, input, createdAt: Date.now(), workspaceId });
      return pollPlanningJob(error.jobId, input, onProgress, signal);
    }
    throw error;
  }
  onProgress(started.progress);
  writeStoredJob({ jobId: started.jobId, input, createdAt: Date.now(), progress: started.progress, workspaceId });
  return pollPlanningJob(started.jobId, input, onProgress, signal);
}

export async function reconnectPlanningJob(onProgress: (progress: PlanningProgress) => void, signal?: AbortSignal): Promise<{ result: PlanningResult; input: PlanningInput } | null> {
  const active = await requestJson<{ active: boolean; jobId?: string; progress?: PlanningProgress }>("/api/plan/active", { signal });
  if (!active.active || !active.jobId) { writeStoredJob(null); return null; }
  const stored = readStoredJob();
  const input = stored?.input || ({ freeText: "", city: "", startDate: "", days: 3, budget: 0, style: "", preferences: [], pace: "medium", transport: "公共交通优先", hotelPreference: "", deepReasoning: true, partySize: 2 } as PlanningInput);
  if (active.progress) onProgress(active.progress);
  writeStoredJob({ jobId: active.jobId, input, createdAt: stored?.createdAt || Date.now(), progress: active.progress, workspaceId: stored?.workspaceId });
  return { result: await pollPlanningJob(active.jobId, input, onProgress, signal), input };
}

export async function retryPlanningJob(onProgress: (progress: PlanningProgress) => void, signal?: AbortSignal): Promise<{ result: PlanningResult; input: PlanningInput }> {
  const stored = readStoredJob();
  const resumed = await requestJson<StartResponse & { input?: PlanningInput }>("/api/plan/retry", {
    method: "POST",
    body: JSON.stringify(stored?.jobId ? { jobId: stored.jobId } : {}),
    signal,
  });
  const input = resumed.input || stored?.input || ({ freeText: "", city: "", startDate: "", days: 3, budget: 0, style: "", preferences: [], pace: "medium", transport: "公共交通优先", hotelPreference: "", deepReasoning: true, partySize: 2 } as PlanningInput);
  onProgress(resumed.progress);
  writeStoredJob({ jobId: resumed.jobId, input, createdAt: stored?.createdAt || Date.now(), progress: resumed.progress, workspaceId: stored?.workspaceId });
  return { result: await pollPlanningJob(resumed.jobId, input, onProgress, signal), input };
}

export async function cancelPlanningJob(): Promise<boolean> {
  const stored = readStoredJob();
  if (!stored?.jobId) return false;
  const result = await requestJson<{ cancelled: boolean }>("/api/plan/cancel", { method: "POST", body: JSON.stringify({ jobId: stored.jobId }) });
  writeStoredJob(null);
  return result.cancelled;
}

export function abandonPlanningJob(): void { writeStoredJob(null); }

export function hasStoredPlanningJob(): boolean { return Boolean(readStoredJob()?.jobId); }

export function getStoredPlanningWorkspaceId(): string | null { return readStoredJob()?.workspaceId ?? null; }

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
