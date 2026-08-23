import assert from "node:assert/strict";
import test from "node:test";

import {
  YUANJING_CHAT_COMPLETIONS,
  aiApiKey,
  aiEndpoint,
  aiModelCandidates,
  aiPrimaryModel,
} from "../worker/domain/model-routing.ts";

test("defaults to the documented Yuanjing endpoint and tested DeepSeek planner", () => {
  assert.equal(aiEndpoint({}), YUANJING_CHAT_COMPLETIONS);
  assert.equal(aiPrimaryModel({}, "extract"), "glm-5");
  assert.equal(aiPrimaryModel({}, "planner"), "deepseek-v4-pro-0813");
});

test("uses GLM for extraction and chat, with DeepSeek fallbacks for rate limits", () => {
  assert.deepEqual(aiModelCandidates({}, "extract"), ["glm-5", "deepseek-v4-pro-0813"]);
  assert.deepEqual(aiModelCandidates({}, "explain"), ["glm-5", "deepseek-v4-pro-0813"]);
});

test("keeps planning, decision and repair on DeepSeek V4 Pro", () => {
  assert.deepEqual(aiModelCandidates({}, "planner"), ["deepseek-v4-pro-0813"]);
  assert.deepEqual(aiModelCandidates({}, "repair"), ["deepseek-v4-pro-0813"]);
});

test("keeps legacy secret and model variable names compatible", () => {
  assert.equal(aiApiKey({ DEEPSEEK_API_KEY: "legacy-key" }), "legacy-key");
  assert.equal(aiPrimaryModel({ DEEPSEEK_PLANNER_MODEL: "custom-planner" }, "planner"), "custom-planner");
});
