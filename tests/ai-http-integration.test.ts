import assert from "node:assert/strict";
import test from "node:test";
import { handleTravelApi } from "../worker/travel-api.ts";

test("chat HTTP boundary invokes the configured model through the throttle and returns real content", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://example.test/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: "disabled" });
    return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { content: "模型返回的测试内容" } }] });
  };
  try {
    const url = new URL("http://localhost/api/agent");
    const response = await handleTravelApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "测试" }) }), {
      AI_API_KEY: "non-secret-test-placeholder", AI_API_BASE_URL: "https://example.test/v1/chat/completions", AI_EXPLAIN_MODEL: "deepseek-v4-flash", AI_STRICT_MODEL_ROUTING: "true",
    }, url);
    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { message: "模型返回的测试内容", model: "deepseek-v4-flash", networkToolCalls: [] });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
