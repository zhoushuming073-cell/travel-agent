import type { AdaptiveResearchBudget } from "../../domain/research-budget.ts";
import type {
  ResearchEvidence,
  ResearchGap,
  ResearchRequest,
  SearchResultCandidate,
  SynthesizedFact,
} from "../../domain/research-types.ts";
import {
  createPlannerResearchState,
  researchMicroStepLabel,
  type PlannerResearchState,
} from "./research-state.ts";

export const RESEARCH_QUERY_BATCH_SIZE = 2;
export const RESEARCH_PAGE_BATCH_SIZE = 3;
export const RESEARCH_RESULTS_PER_QUERY = 3;
export const RESEARCH_PAGE_LIMIT_PER_ROUND = 12;
export const RESEARCH_EVIDENCE_LIMIT_PER_ROUND = 24;
export const RESEARCH_FOLLOWUP_QUERY_LIMIT = 4;
export const RESEARCH_FOLLOWUP_PAGE_LIMIT = 6;
export const RESEARCH_FOLLOWUP_EVIDENCE_LIMIT = 12;

export interface ResearchSearchExecution {
  request: ResearchRequest;
  results: SearchResultCandidate[];
  providersAttempted?: string[];
  providerFailures?: unknown[];
  executedAt?: string;
}

export interface ResearchPageRecord {
  url: string;
  status: string;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  fetchedAt?: string;
  error?: string;
  text?: string;
}

export interface ResearchArtifactStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<{ created: boolean } | void>;
}

export interface ResearchRuntime {
  initialize(): Promise<{ gaps: ResearchGap[]; budget: AdaptiveResearchBudget; maxRounds: number }>;
  planQueries(state: PlannerResearchState): Promise<{
    requests: ResearchRequest[];
    model?: string | null;
    modelStatus?: PlannerResearchState["modelStatus"];
    degradedReason?: string;
    aiCalls?: number;
  }>;
  search(requests: ResearchRequest[], operationId: string): Promise<ResearchSearchExecution[]>;
  fetch(urls: string[], operationId: string): Promise<ResearchPageRecord[]>;
  extract(input: {
    requests: ResearchRequest[];
    executions: ResearchSearchExecution[];
    pages: ResearchPageRecord[];
    operationId: string;
  }): Promise<ResearchEvidence[]>;
  refine(evidence: ResearchEvidence[], operationId: string): Promise<{
    evidence: ResearchEvidence[];
    model?: string | null;
    degradedReason?: string;
    aiCalls?: number;
  }>;
  fuse(input: {
    state: PlannerResearchState;
    requests: ResearchRequest[];
    executions: ResearchSearchExecution[];
    pages: ResearchPageRecord[];
    evidence: ResearchEvidence[];
  }): Promise<{
    facts: SynthesizedFact[];
    gaps: ResearchGap[];
    budget: AdaptiveResearchBudget;
    informationGain: number;
    continueResearch: boolean;
    stopReason: string;
  }>;
  finalize(input: {
    state: PlannerResearchState;
    requests: ResearchRequest[];
    executions: ResearchSearchExecution[];
    pages: ResearchPageRecord[];
    evidence: ResearchEvidence[];
    facts: SynthesizedFact[];
  }): Promise<unknown>;
}

export interface ResearchAdvanceResult {
  state: PlannerResearchState;
  operationId: string;
  reused: boolean;
  done: boolean;
  report?: unknown;
}

export async function planResearchQueriesWithFallback<T>(input: {
  ai: () => Promise<T>;
  deterministic: () => T | Promise<T>;
  shouldRethrow?: (error: unknown) => boolean;
}): Promise<{ value: T; degradedReason?: string }> {
  try {
    return { value: await input.ai() };
  } catch (error) {
    if (input.shouldRethrow?.(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      value: await input.deterministic(),
      degradedReason: `AI research query planner timeout/unavailable: ${message}`,
    };
  }
}

const stateKey = "research:state:v30";
const roundKey = (round: number, suffix: string) => `research:v30:round:${round}:${suffix}`;
const operationKey = (operationId: string) => `research:v30:operation:${operationId}`;
const batch = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

function nowIso() {
  return new Date().toISOString();
}

function operationId(state: PlannerResearchState): string {
  const cursor = state.cursor;
  return `r${state.round}:${cursor.step}${"batch" in cursor ? `:${cursor.batch}` : ""}`;
}

async function loadRequests(store: ResearchArtifactStore, state: PlannerResearchState): Promise<ResearchRequest[]> {
  const rows = await Promise.all(state.queryArtifactKeys.map((key) => store.get<ResearchRequest[]>(key)));
  const byId = new Map<string, ResearchRequest>();
  for (const request of rows.flatMap((value) => value ?? [])) byId.set(request.queryId, request);
  return [...byId.values()];
}

async function loadOperations<T>(store: ResearchArtifactStore, ids: string[]): Promise<T[]> {
  const rows = await Promise.all(ids.map((id) => store.get<T[]>(operationKey(id))));
  return rows.flatMap((value) => value ?? []);
}

export function researchPageUrlsForRound(
  executions: ResearchSearchExecution[],
  targetPageBudget: number,
): string[] {
  return [...new Set(executions.flatMap((execution) => execution.results
    .slice(0, RESEARCH_RESULTS_PER_QUERY)
    .map((result) => result.url)
    .filter((url): url is string => Boolean(url))))]
    .slice(0, Math.max(0, Math.min(targetPageBudget, RESEARCH_PAGE_LIMIT_PER_ROUND)));
}

export function evidenceForResearchRefinement(
  rows: ResearchEvidence[],
  limit = RESEARCH_EVIDENCE_LIMIT_PER_ROUND,
): ResearchEvidence[] {
  return rows.slice(0, Math.min(limit, RESEARCH_EVIDENCE_LIMIT_PER_ROUND));
}

async function persistState(store: ResearchArtifactStore, state: PlannerResearchState): Promise<void> {
  state.updatedAt = nowIso();
  state.remainingBudget = state.budget.remainingCostUnits;
  state.retryNotBefore = undefined;
  await store.put(stateKey, state);
}

export async function advancePlannerResearch(
  store: ResearchArtifactStore,
  runtime: ResearchRuntime,
): Promise<ResearchAdvanceResult> {
  let state = await store.get<PlannerResearchState>(stateKey);
  if (!state) {
    const initialized = await runtime.initialize();
    state = createPlannerResearchState(initialized);
    await persistState(store, state);
    return { state, operationId: "init", reused: false, done: false };
  }

  const opId = operationId(state);
  const opKey = operationKey(opId);
  let reused = false;

  if (state.cursor.step === "done") {
    const report = await store.get<unknown>("research:report:v30");
    return { state, operationId: opId, reused: true, done: true, report: report ?? undefined };
  }

  if (state.cursor.step === "plan_queries") {
    let planned = await store.get<Awaited<ReturnType<ResearchRuntime["planQueries"]>>>(opKey);
    if (planned) reused = true;
    else {
      planned = await runtime.planQueries(state);
      await store.put(opKey, planned);
    }
    const key = roundKey(state.round, "queries");
    await store.put(key, planned.requests);
    if (!state.queryArtifactKeys.includes(key)) state.queryArtifactKeys.push(key);
    state.pendingQueryIds = planned.requests.map((request) => request.queryId);
    state.model = planned.model ?? state.model;
    state.modelStatus = planned.modelStatus ?? state.modelStatus;
    state.aiCallCount += planned.aiCalls ?? 0;
    if (planned.degradedReason && !state.degradedReasons.includes(planned.degradedReason)) state.degradedReasons.push(planned.degradedReason);
    state.cursor = planned.requests.length ? { step: "search_batch", batch: 0 } : { step: "finalize" };
    await persistState(store, state);
    return { state, operationId: opId, reused, done: false };
  }

  const requests = await loadRequests(store, state);
  const roundRequests = (await store.get<ResearchRequest[]>(roundKey(state.round, "queries"))) ?? [];

  if (state.cursor.step === "search_batch") {
    const batches = batch(roundRequests, RESEARCH_QUERY_BATCH_SIZE);
    const current = batches[state.cursor.batch] ?? [];
    let value = await store.get<ResearchSearchExecution[]>(opKey);
    if (value) reused = true;
    else {
      value = await runtime.search(current, opId);
      await store.put(opKey, value);
    }
    if (!state.searchOperationIds.includes(opId)) state.searchOperationIds.push(opId);
    for (const request of current) {
      if (!state.completedQueryIds.includes(request.queryId)) state.completedQueryIds.push(request.queryId);
    }
    const next = state.cursor.batch + 1;
    state.cursor = next < batches.length ? { step: "search_batch", batch: next } : { step: "fetch_batch", batch: 0 };
    await persistState(store, state);
    return { state, operationId: opId, reused, done: false };
  }

  const executions = await loadOperations<ResearchSearchExecution>(store, state.searchOperationIds);
  const roundQueryIds = new Set(roundRequests.map((request) => request.queryId));
  const roundExecutions = executions.filter((execution) => roundQueryIds.has(execution.request.queryId));
  const pageUrls = researchPageUrlsForRound(
    roundExecutions,
    Math.min(state.budget.targetPageBudget, state.round === 0 ? RESEARCH_PAGE_LIMIT_PER_ROUND : RESEARCH_FOLLOWUP_PAGE_LIMIT),
  );

  if (state.cursor.step === "fetch_batch") {
    const batches = batch(pageUrls, RESEARCH_PAGE_BATCH_SIZE);
    if (!batches.length) {
      state.cursor = { step: "extract_batch", batch: 0 };
      await persistState(store, state);
      return { state, operationId: opId, reused: false, done: false };
    }
    const current = batches[state.cursor.batch] ?? [];
    let value = await store.get<ResearchPageRecord[]>(opKey);
    if (value) reused = true;
    else {
      value = await runtime.fetch(current, opId);
      await store.put(opKey, value);
    }
    if (!state.fetchOperationIds.includes(opId)) state.fetchOperationIds.push(opId);
    const next = state.cursor.batch + 1;
    state.cursor = next < batches.length ? { step: "fetch_batch", batch: next } : { step: "extract_batch", batch: 0 };
    await persistState(store, state);
    return { state, operationId: opId, reused, done: false };
  }

  const pages = await loadOperations<ResearchPageRecord>(store, state.fetchOperationIds);

  if (state.cursor.step === "extract_batch") {
    const batches = batch(roundRequests, RESEARCH_QUERY_BATCH_SIZE);
    if (!batches.length) {
      state.cursor = { step: "fuse" };
      await persistState(store, state);
      return { state, operationId: opId, reused: false, done: false };
    }
    const current = batches[state.cursor.batch] ?? [];
    let value = await store.get<ResearchEvidence[]>(opKey);
    if (value) reused = true;
    else {
      value = await runtime.extract({ requests: current, executions: roundExecutions, pages, operationId: opId });
      await store.put(opKey, value);
    }
    if (!state.extractOperationIds.includes(opId)) state.extractOperationIds.push(opId);
    const next = state.cursor.batch + 1;
    state.cursor = next < batches.length ? { step: "extract_batch", batch: next } : { step: "refine_batch", batch: 0 };
    await persistState(store, state);
    return { state, operationId: opId, reused, done: false };
  }

  const roundExtractIds = state.extractOperationIds.filter((id) => id.startsWith(`r${state.round}:`));
  const extracted = evidenceForResearchRefinement(
    await loadOperations<ResearchEvidence>(store, roundExtractIds),
    state.round === 0 ? RESEARCH_EVIDENCE_LIMIT_PER_ROUND : RESEARCH_FOLLOWUP_EVIDENCE_LIMIT,
  );

  if (state.cursor.step === "refine_batch") {
    const batches = batch(extracted, 12);
    if (!batches.length) {
      state.cursor = { step: "fuse" };
      await persistState(store, state);
      return { state, operationId: opId, reused: false, done: false };
    }
    const current = batches[state.cursor.batch] ?? [];
    let refined = await store.get<Awaited<ReturnType<ResearchRuntime["refine"]>>>(opKey);
    if (refined) reused = true;
    else {
      refined = await runtime.refine(current, opId);
      await store.put(opKey, refined);
    }
    if (!state.refineOperationIds.includes(opId)) state.refineOperationIds.push(opId);
    state.model = refined.model ?? state.model;
    state.aiCallCount += refined.aiCalls ?? 0;
    if (refined.degradedReason && !state.degradedReasons.includes(refined.degradedReason)) state.degradedReasons.push(refined.degradedReason);
    const next = state.cursor.batch + 1;
    state.cursor = next < batches.length ? { step: "refine_batch", batch: next } : { step: "fuse" };
    await persistState(store, state);
    return { state, operationId: opId, reused, done: false };
  }

  const evidence = await loadOperations<ResearchEvidence>(store, state.refineOperationIds);

  if (state.cursor.step === "fuse") {
    let fused = await store.get<Awaited<ReturnType<ResearchRuntime["fuse"]>>>(opKey);
    if (fused) reused = true;
    else {
      fused = await runtime.fuse({ state, requests, executions, pages, evidence });
      await store.put(opKey, fused);
    }
    const factsKey = roundKey(state.round, "facts");
    await store.put(factsKey, fused.facts);
    state.factsArtifactKey = factsKey;
    state.gaps = fused.gaps;
    state.budget = fused.budget;
    state.informationGains.push(fused.informationGain);
    state.stopReason = fused.stopReason;
    if (fused.continueResearch && state.round + 1 < state.maxRounds) {
      state.round += 1;
      state.pendingQueryIds = [];
      state.cursor = { step: "plan_queries" };
    } else state.cursor = { step: "finalize" };
    await persistState(store, state);
    return { state, operationId: opId, reused, done: false };
  }

  const facts = state.factsArtifactKey ? (await store.get<SynthesizedFact[]>(state.factsArtifactKey)) ?? [] : [];
  let report = await store.get<unknown>("research:report:v30");
  if (report) reused = true;
  else {
    report = await runtime.finalize({ state, requests, executions, pages, evidence, facts });
    await store.put("research:report:v30", report);
  }
  state.cursor = { step: "done" };
  await persistState(store, state);
  return { state, operationId: opId, reused, done: true, report };
}

export function currentResearchMicroStep(state: PlannerResearchState | null): string {
  return state ? researchMicroStepLabel(state) : "planner_research:init";
}
