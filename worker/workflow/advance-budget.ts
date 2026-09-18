export const ADVANCE_SOFT_BUDGET_MS = 40_000;
export const ADVANCE_COMMIT_RESERVE_MS = 6_000;
export const EXTERNAL_CALL_MAX_MS = 30_000;
export const MIN_EXTERNAL_CALL_WINDOW_MS = 8_000;
export const MAX_IN_REQUEST_THROTTLE_WAIT_MS = 2_000;

export interface AdvanceExecutionBudget {
  startedAt: number;
  deadlineAt: number;
  softBudgetMs: number;
}

export function createAdvanceExecutionBudget(
  now = Date.now(),
  softBudgetMs = ADVANCE_SOFT_BUDGET_MS,
): AdvanceExecutionBudget {
  return { startedAt: now, deadlineAt: now + softBudgetMs, softBudgetMs };
}

export function remainingAdvanceMs(budget: AdvanceExecutionBudget, now = Date.now()): number {
  return Math.max(0, budget.deadlineAt - now);
}

export function externalCallTimeoutMs(
  budget: AdvanceExecutionBudget,
  requestedMs = EXTERNAL_CALL_MAX_MS,
  now = Date.now(),
): number {
  const available = remainingAdvanceMs(budget, now) - ADVANCE_COMMIT_RESERVE_MS;
  const minimumUsefulWindow = Math.min(requestedMs, MIN_EXTERNAL_CALL_WINDOW_MS);
  if (available < minimumUsefulWindow) throw new AdvanceBudgetExhaustedError(Math.max(0, available));
  return Math.max(1_000, Math.min(EXTERNAL_CALL_MAX_MS, requestedMs, available));
}

export class AdvanceBudgetExhaustedError extends Error {
  readonly code = "ADVANCE_BUDGET_EXHAUSTED";
  readonly retryAfterMs: number;

  constructor(availableMs = 0, retryAfterMs = 1_000) {
    super(`Advance execution budget exhausted with ${Math.max(0, availableMs)}ms available`);
    this.name = "AdvanceBudgetExhaustedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isAdvanceBudgetExhausted(error: unknown): error is AdvanceBudgetExhaustedError {
  return error instanceof AdvanceBudgetExhaustedError
    || (error instanceof Error && error.message.includes("ADVANCE_BUDGET_EXHAUSTED"));
}
