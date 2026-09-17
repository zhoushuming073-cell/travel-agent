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
