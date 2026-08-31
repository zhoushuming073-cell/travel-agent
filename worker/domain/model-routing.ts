export type AiPurpose = "extract" | "research" | "enrich" | "planner" | "critic" | "repair" | "explain";

export type AiFailureCode =
  | "MODEL_NOT_FOUND"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_JSON"
  | "CONTENT_INVALID"
  | "UNKNOWN";

export const YUANJING_CHAT_COMPLETIONS =
  "https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1/chat/completions";

// Yuanjing currently reports QPM throttling when planning calls are made in a
// short burst. Keep the circuit slightly longer than one minute so the durable
// stage retry performs a real second model call instead of immediately falling
// into deterministic recovery while the local circuit is still open.
export const AI_RATE_LIMIT_COOLDOWN_MS = 65_000;

const DEFAULT_MODELS: Record<AiPurpose, string[]> = {
  extract: ["deepseek-v4-flash"],
  // The competition document fixes the Pro model id below. Flash remains an
  // explicit compatibility fallback because model access is granted per key:
  // a syntactically valid Pro id can still return 404 for an unentitled key.
  research: ["deepseek-v4-pro-0813", "deepseek-v4-flash"],
  enrich: ["deepseek-v4-pro-0813", "deepseek-v4-flash"],
  planner: ["deepseek-v4-pro-0813", "deepseek-v4-flash"],
  critic: ["deepseek-v4-pro-0813", "deepseek-v4-flash"],
  repair: ["deepseek-v4-pro-0813", "deepseek-v4-flash"],
  explain: ["deepseek-v4-flash", "deepseek-v4-pro-0813"],
};

const modelCircuit = new Map<string, { code: AiFailureCode; reason: string; until: number }>();

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export function aiApiKey(env: Record<string, unknown>) {
  return clean(env.AI_API_KEY || env.DEEPSEEK_API_KEY);
}

export function aiEndpoint(env: Record<string, unknown>) {
  return clean(env.AI_API_BASE_URL) || YUANJING_CHAT_COMPLETIONS;
}

export function aiModelCandidates(env: Record<string, unknown>, purpose: AiPurpose) {
  const configured: Record<AiPurpose, unknown[]> = {
    extract: [env.AI_EXTRACT_MODEL, env.DEEPSEEK_EXTRACT_MODEL],
    research: [env.AI_RESEARCH_MODEL, env.DEEPSEEK_RESEARCH_MODEL, env.AI_PLANNER_MODEL],
    enrich: [env.AI_ENRICH_MODEL, env.DEEPSEEK_ENRICH_MODEL, env.AI_RESEARCH_MODEL, env.AI_PLANNER_MODEL],
    planner: [env.AI_PLANNER_MODEL, env.DEEPSEEK_PLANNER_MODEL, env.DEEPSEEK_MODEL],
    critic: [env.AI_CRITIC_MODEL, env.DEEPSEEK_CRITIC_MODEL, env.AI_PLANNER_MODEL],
    repair: [env.AI_REPAIR_MODEL, env.DEEPSEEK_REPAIR_MODEL, env.AI_REPAIR_FALLBACK_MODEL],
    explain: [env.AI_EXPLAIN_MODEL, env.DEEPSEEK_MODEL, env.AI_PLANNER_MODEL, env.DEEPSEEK_PLANNER_MODEL],
  };
  const sharedFallbacks = clean(env.AI_COMPATIBLE_MODEL_FALLBACKS).split(/[,，;\s]+/).filter(Boolean);
  const skipped = new Set(clean(env.AI_SKIP_MODELS).split(/[,，;\s]+/).filter(Boolean));
  return [...new Set([...configured[purpose].map(clean).filter(Boolean), ...sharedFallbacks, ...DEFAULT_MODELS[purpose]])]
    .filter((model) => !/^glm(?:-|$)/i.test(model) && !skipped.has(model));
}

export function aiPrimaryModel(env: Record<string, unknown>, purpose: AiPurpose) {
  return aiModelCandidates(env, purpose)[0];
}

export function modelFamily(model: string) {
  if (/deepseek/i.test(model)) return "DeepSeek";
  return "AI";
}

export function classifyAiFailure(error: unknown): AiFailureCode {
  const message = clean(error instanceof Error ? error.message : error).toLowerCase();
  if (/\b404\b|model[^\n]*(?:not found|不存在)|模型不存在/.test(message)) return "MODEL_NOT_FOUND";
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|无权限|鉴权|api key/.test(message)) return "UNAUTHORIZED";
  if (/\b429\b|rate.?limit|too many|请求过于频繁|额度/.test(message)) return "RATE_LIMITED";
  if (/timeout|timed out|响应超时|aborterror/.test(message)) return "TIMEOUT";
  if (/invalid json|json.*(?:截断|语法|格式)|有效 json/.test(message)) return "INVALID_JSON";
  if (/没有返回(?:消息|内容)|content.*invalid|内容不完整/.test(message)) return "CONTENT_INVALID";
  if (/\b5\d\d\b|provider|上游服务|服务不可用/.test(message)) return "PROVIDER_UNAVAILABLE";
  if (/network|fetch failed|econn|dns|网络/.test(message)) return "NETWORK_ERROR";
  return "UNKNOWN";
}

export function circuitKey(endpoint: string, model: string) {
  return `${clean(endpoint)}|${clean(model)}`;
}

export function modelCircuitState(endpoint: string, model: string, now = Date.now()) {
  const key = circuitKey(endpoint, model);
  const state = modelCircuit.get(key);
  if (!state) return null;
  if (state.until <= now) {
    modelCircuit.delete(key);
    return null;
  }
  return { ...state };
}

export function openModelCircuit(endpoint: string, model: string, error: unknown, now = Date.now()) {
  const code = classifyAiFailure(error);
  const durations: Record<AiFailureCode, number> = {
    MODEL_NOT_FOUND: 6 * 60 * 60 * 1000,
    UNAUTHORIZED: 60 * 60 * 1000,
    RATE_LIMITED: AI_RATE_LIMIT_COOLDOWN_MS,
    PROVIDER_UNAVAILABLE: 60 * 1000,
    NETWORK_ERROR: 30 * 1000,
    TIMEOUT: 60 * 1000,
    INVALID_JSON: 0,
    CONTENT_INVALID: 0,
    UNKNOWN: 15 * 1000,
  };
  const until = now + durations[code];
  if (until > now) modelCircuit.set(circuitKey(endpoint, model), { code, reason: clean(error instanceof Error ? error.message : error), until });
  return { code, until };
}

export function closeModelCircuit(endpoint: string, model: string) {
  modelCircuit.delete(circuitKey(endpoint, model));
}
