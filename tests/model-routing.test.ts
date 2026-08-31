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
  assert.equal(aiPrimaryModel({}, "extract"), "deepseek-v4-flash");
  assert.equal(aiPrimaryModel({}, "planner"), "deepseek-v4-pro-0813");
});

test("uses V4 Flash for extraction and chat and rejects stale GLM configuration", () => {
  assert.deepEqual(aiModelCandidates({}, "extract"), ["deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({}, "explain"), ["deepseek-v4-flash", "deepseek-v4-pro-0813"]);
  assert.deepEqual(aiModelCandidates({ AI_EXTRACT_MODEL: "glm-5" }, "extract"), ["deepseek-v4-flash"]);
});

test("keeps documented Pro first and automatically falls back to verified Flash", () => {
  assert.deepEqual(aiModelCandidates({}, "planner"), ["deepseek-v4-pro-0813", "deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({}, "repair"), ["deepseek-v4-pro-0813", "deepseek-v4-flash"]);
  assert.deepEqual(aiModelCandidates({ AI_PLANNER_MODEL: "deepseek-v4-flash" }, "planner"), ["deepseek-v4-flash", "deepseek-v4-pro-0813"]);
  assert.deepEqual(aiModelCandidates({ AI_PLANNER_MODEL: "deepseek-v4-flash", AI_SKIP_MODELS: "deepseek-v4-pro-0813" }, "planner"), ["deepseek-v4-flash"]);
});

test("keeps legacy secret and model variable names compatible", () => {
  assert.equal(aiApiKey({ DEEPSEEK_API_KEY: "legacy-key" }), "legacy-key");
  assert.equal(aiPrimaryModel({ DEEPSEEK_PLANNER_MODEL: "custom-planner" }, "planner"), "custom-planner");
});
