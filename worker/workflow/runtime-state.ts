export type WorkflowExecutionMode = "running" | "waiting" | "stalled";

export interface WorkflowRuntimeState {
  version: 30;
  mode: WorkflowExecutionMode;
  currentStage: string;
  currentMicroStep: string;
  microStepStartedAt: number;
  lastHeartbeatAt: number;
  retryNotBefore?: number;
  attempt: number;
  provider?: string;
  model?: string;
  providerCallStartedAt?: number;
  providerCallDurationMs?: number;
  providerOutcome?: "running" | "success" | "timeout" | "rate_limited" | "failed" | "aborted";
  degradedReason?: string;
}

export interface WorkflowWaitSchedule {
  retryAfterMs: number;
  retryNotBefore: number;
}

export function leaseWaitSchedule(
  leaseExpiresAt: number | null | undefined,
  now = Date.now(),
  fallbackMs = 10_000,
): WorkflowWaitSchedule {
  const knownExpiry = Number(leaseExpiresAt || 0);
  const retryNotBefore = knownExpiry > now
    ? knownExpiry + 500
    : now + Math.max(500, fallbackMs);
  return {
    retryAfterMs: Math.max(500, retryNotBefore - now),
    retryNotBefore,
  };
}

export function runtimeStateForClient(
  state: WorkflowRuntimeState | null,
  now = Date.now(),
  leaseExpiresAt?: number | null,
): WorkflowRuntimeState | null {
  if (!state) return null;
  const waiting = Boolean(state.retryNotBefore && state.retryNotBefore > now);
  const heartbeatStale = now - state.lastHeartbeatAt > 55_000;
  const leaseExpired = !leaseExpiresAt || leaseExpiresAt <= now;
  return {
    ...state,
    mode: waiting ? "waiting" : heartbeatStale && leaseExpired ? "stalled" : state.mode === "waiting" ? "running" : state.mode,
  };
}
