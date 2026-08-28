/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Cloudflare Workflow runtime types are generated only after account deployment.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { signedHeaders, verifySignedRequest } from "./signing.ts";

interface Env {
  TRAVEL_WORKFLOW: Workflow;
  SITE_BASE_URL: string;
  ORCHESTRATOR_SHARED_SECRET: string;
}

const STAGES = [
  ["parse_profile", 3, "2 minutes"],
  ["collect_sources", 3, "4 minutes"],
  ["build_knowledge", 3, "2 minutes"],
  ["build_matrix", 3, "3 minutes"],
  ["planner_research", 3, "3 minutes"],
  ["planner_memo", 2, "3 minutes"],
  ["variant_hot", 2, "150 seconds"],
  ["variant_niche", 2, "150 seconds"],
  ["variant_relax", 2, "150 seconds"],
  ["audit_initial", 2, "2 minutes"],
  ["repair_round_1", 2, "150 seconds"],
  ["audit_round_1", 2, "2 minutes"],
  ["repair_round_2", 2, "150 seconds"],
  ["audit_final", 2, "2 minutes"],
  ["final_transit", 3, "4 minutes"],
  ["compile_result", 2, "3 minutes"],
] as const;

async function callSite(env: Env, path: string, body: Record<string, unknown>) {
  const text = JSON.stringify(body);
  const headers = await signedHeaders(env.ORCHESTRATOR_SHARED_SECRET, "POST", path, text);
  const response = await fetch(new URL(path, env.SITE_BASE_URL), { method: "POST", headers, body: text });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error || `Sites stage failed (HTTP ${response.status})`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return payload;
}

export class TravelPlanningWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event, step) {
    const jobId = event.payload.jobId;
    const startedAt = Date.now();
    try {
      for (const [stage, limit, timeout] of STAGES) {
        if (Date.now() - startedAt > 20 * 60 * 1000) {
          await step.do("hard-deadline", { retries: { limit: 1 }, timeout: "30 seconds" }, () => callSite(this.env, "/api/internal/plan/error", { jobId, code: "HARD_DEADLINE", message: "规划超过 20 分钟硬截止，任务已明确终止" }));
          return { status: "error", code: "HARD_DEADLINE" };
        }
        const result = await step.do(stage, {
          retries: { limit, delay: stage.startsWith("variant_") || stage.startsWith("repair_") ? "10 seconds" : "5 seconds", backoff: "exponential" },
          timeout,
        }, () => callSite(this.env, "/api/internal/plan/stage", { jobId, stage, workflowId: event.instanceId }));
        if (result?.cancelled || result?.done) return result;
      }
      return { status: "done" };
    } catch (error) {
      await step.do("record-terminal-error", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "30 seconds" }, () => callSite(this.env, "/api/internal/plan/error", { jobId, code: "WORKFLOW_STAGE_FAILED", message: String(error?.message || error).slice(0, 600) }));
      throw error;
    }
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, engine: "v29-workflow" });
    if (!await verifySignedRequest(request, env.ORCHESTRATOR_SHARED_SECRET)) return json({ error: "invalid signature" }, 401);
    const body = await request.json().catch(() => ({}));
    if (url.pathname === "/v1/jobs/start" && request.method === "POST") {
      const id = String(body.jobId || "");
      if (!id) return json({ error: "jobId required" }, 400);
      const instance = await env.TRAVEL_WORKFLOW.create({ id, params: { jobId: id } });
      return json({ workflowId: instance.id, status: "queued" }, 202);
    }
    const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(status|cancel)$/);
    if (match) {
      const instance = await env.TRAVEL_WORKFLOW.get(decodeURIComponent(match[1]));
      if (match[2] === "cancel" && request.method === "POST") await instance.terminate();
      return json({ workflowId: match[1], ...(await instance.status()) });
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const dispatch = await callSite(env, "/api/internal/plan/dispatch", { checkedAt: new Date().toISOString() });
      for (const jobId of dispatch.queued || []) {
        try { await env.TRAVEL_WORKFLOW.create({ id: jobId, params: { jobId } }); }
        catch {
          const instance = await env.TRAVEL_WORKFLOW.get(jobId);
          const status = await instance.status();
          if (["errored", "terminated"].includes(String(status?.status))) await instance.restart();
        }
      }
      for (const jobId of dispatch.cancelled || []) {
        try { await (await env.TRAVEL_WORKFLOW.get(jobId)).terminate(); } catch { /* cancellation in D1 remains authoritative */ }
      }
      for (const jobId of dispatch.stale || []) {
        let status = "unknown";
        try { status = String((await (await env.TRAVEL_WORKFLOW.get(jobId)).status())?.status || "unknown"); } catch { status = "unknown"; }
        if (["errored", "terminated", "unknown"].includes(status)) await callSite(env, "/api/internal/plan/error", { jobId, code: "WORKFLOW_STALE", message: `后台 Workflow 已停止（${status}），任务未永久停留在生成中` });
      }
    })());
  },
};
