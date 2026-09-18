import assert from "node:assert/strict";
import test from "node:test";

import {
  YUANJING_CHAT_COMPLETIONS,
  aiApiKey,
  aiEndpoint,
  aiModelCandidates,
  aiPrimaryModel,
  shouldTryAlternateModel,
} from "../worker/domain/model-routing.ts";

test("defaults to the official DeepSeek endpoint and current planner model", () => {
  assert.equal(aiEndpoint({}), YUANJING_CHAT_COMPLETIONS);
  assert.equal(aiPrimaryModel({}, "extract"), "deepseek-flash");
  assert.equal(aiPrimaryModel({}, "planner"), "deepseek-v4-pro");
});

test("uses V4 Flash for extraction and V4 Pro for explanation", () => {
  assert.deepEqual(aiModelCandidates({}, "extract"), ["deepseek-flash"]);
  assert.deepEqual(aiModelCandidates({}, "explain"), ["deepseek-v4-pro", "deepseek-flash", "deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({ AI_EXTRACT_MODEL: "glm-5" }, "extract"), ["deepseek-flash"]);
});

test("keeps documented Pro first and automatically falls back to verified Flash", () => {
  assert.deepEqual(aiModelCandidates({}, "planner"), ["deepseek-v4-pro", "deepseek-flash", "deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({}, "repair"), ["deepseek-v4-pro", "deepseek-flash", "deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({ AI_PLANNER_MODEL: "deepseek-v4-flash" }, "planner"), ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"]);
  assert.deepEqual(aiModelCandidates({ AI_PLANNER_MODEL: "deepseek-v4-flash", AI_SKIP_MODELS: "deepseek-v4-pro" }, "planner"), ["deepseek-v4-flash", "deepseek-flash"]);
});

test("strict routing never crosses the configured responsibility boundary", () => {
  assert.deepEqual(aiModelCandidates({ AI_EXTRACT_MODEL: "deepseek-v4-flash", AI_STRICT_MODEL_ROUTING: "true" }, "extract"), ["deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({ AI_PLANNER_MODEL: "deepseek-v4-pro", AI_STRICT_MODEL_ROUTING: "true" }, "planner"), ["deepseek-v4-pro"]);
});

test("keeps legacy secret and model variable names compatible", () => {
  assert.equal(aiApiKey({ DEEPSEEK_API_KEY: "legacy-key" }), "legacy-key");
  assert.equal(aiPrimaryModel({ DEEPSEEK_PLANNER_MODEL: "custom-planner" }, "planner"), "custom-planner");
});

test("provider-wide failures do not multiply calls across models", () => {
  for (const code of ["TIMEOUT", "NETWORK_ERROR", "PROVIDER_UNAVAILABLE", "UNAUTHORIZED", "RATE_LIMITED"] as const) {
    assert.equal(shouldTryAlternateModel(code), false, code);
  }
  for (const code of ["MODEL_NOT_FOUND", "INVALID_JSON", "CONTENT_INVALID", "UNKNOWN"] as const) {
    assert.equal(shouldTryAlternateModel(code), true, code);
  }
});
