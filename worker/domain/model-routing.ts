export type AiPurpose = "extract" | "planner" | "repair" | "explain";

export const YUANJING_CHAT_COMPLETIONS =
  "https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1/chat/completions";

const DEFAULT_MODELS: Record<AiPurpose, string[]> = {
  extract: ["deepseek-v4-flash"],
  planner: ["deepseek-v4-pro-0813"],
  repair: ["deepseek-v4-pro-0813"],
  explain: ["deepseek-v4-flash", "deepseek-v4-pro-0813"],
};

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
    planner: [env.AI_PLANNER_MODEL, env.DEEPSEEK_PLANNER_MODEL, env.DEEPSEEK_MODEL],
    repair: [env.AI_REPAIR_MODEL, env.DEEPSEEK_REPAIR_MODEL, env.AI_REPAIR_FALLBACK_MODEL],
    explain: [env.AI_EXPLAIN_MODEL, env.DEEPSEEK_MODEL, env.AI_PLANNER_MODEL, env.DEEPSEEK_PLANNER_MODEL],
  };
  return [...new Set([...configured[purpose].map(clean).filter(Boolean), ...DEFAULT_MODELS[purpose]])]
    .filter((model) => !/^glm(?:-|$)/i.test(model));
}

export function aiPrimaryModel(env: Record<string, unknown>, purpose: AiPurpose) {
  return aiModelCandidates(env, purpose)[0];
}

export function modelFamily(model: string) {
  if (/deepseek/i.test(model)) return "DeepSeek";
  return "AI";
}
