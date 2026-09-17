import { EXTERNAL_CALL_MAX_MS } from "./advance-budget.ts";

export type ExternalCallOutcome = "success" | "timeout" | "aborted" | "failed";

export interface ExternalCallTelemetry {
  startedAt: number;
  durationMs: number;
  outcome: ExternalCallOutcome;
  error?: string;
}

export class ExternalCallTimeoutError extends Error {
  readonly code = "EXTERNAL_CALL_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, label = "External call") {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "ExternalCallTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function executeExternalCall<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    onSettled?: (telemetry: ExternalCallTelemetry) => Promise<void> | void;
  } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.min(EXTERNAL_CALL_MAX_MS, options.timeoutMs ?? EXTERNAL_CALL_MAX_MS));
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ExternalCallTimeoutError(timeoutMs, label)), timeoutMs);
  let outcome: ExternalCallOutcome = "failed";
  let detail = "";
  try {
    const value = await operation(controller.signal);
    outcome = "success";
    return value;
  } catch (error) {
    const timedOut = controller.signal.aborted && controller.signal.reason instanceof ExternalCallTimeoutError;
    outcome = timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "failed";
    detail = error instanceof Error ? error.message : String(error);
    if (timedOut) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await options.onSettled?.({ startedAt, durationMs: Math.max(0, now() - startedAt), outcome, error: detail || undefined });
  }
}
