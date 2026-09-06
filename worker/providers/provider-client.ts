/* eslint-disable @typescript-eslint/no-explicit-any -- provider and MCP payloads are validated after transport */
import { cleanText } from "../lib/value-utils.ts";
import { persistentCacheGet, persistentCachePut, recordProviderHealth } from "../persistence.ts";

const mcpMemory = new Map<string, { expiresAt: number; value: any }>();
function fetchOptions(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": "SmartTravelAssistant/1.0 (OpenAI Sites demo)",
      ...(init.headers || {}),
    },
  };
}

function providerNameFor(url: string, source: string): string {
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { hostname = ""; }
  if (/restapi\.amap\.com/.test(hostname)) return "高德地图官方 Web 服务";
  if (/wikipedia\.org|wikimedia\.org/.test(hostname)) return "Wikimedia";
  if (/open-meteo\.com/.test(hostname)) return "Open-Meteo";
  if (/project-osrm\.org/.test(hostname)) return "OSRM";
  if (/openstreetmap\.org/.test(hostname)) return "OpenStreetMap / Nominatim";
  if (/bing\.com/.test(hostname)) return "Bing 新闻 RSS";
  if (/gdeltproject\.org/.test(hostname)) return "GDELT";
  if (/mcpmarket\.cn/.test(hostname)) return `MCPMarket：${source}`;
  if (/api\.deepseek\.com/.test(hostname) || /DeepSeek 官方 API/i.test(source)) {
    const model = source.match(/deepseek-[a-z0-9._-]+/i)?.[0];
    return model ? `DeepSeek 官方 API：${model}` : "DeepSeek 官方 API";
  }
  if (/元景|DeepSeek|联通/i.test(source)) {
    const model = source.match(/deepseek-[a-z0-9._-]+/i)?.[0];
    return model ? `联通元景 AI：${model}` : "联通元景 AI";
  }
  return cleanText(source, hostname || "外部服务").slice(0, 80);
}

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 18000, source = "上游服务") {
  const startedAt = Date.now();
  const provider = providerNameFor(url, source);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, fetchOptions({ ...init, signal: controller.signal }));
      const text = await response.text();
      if (response.ok) {
        const value = text ? JSON.parse(text) : {};
        await recordProviderHealth(provider, { ok: true, latencyMs: Date.now() - startedAt });
        return value;
      }
      // Model quota errors usually need a wider cooldown than an in-request
      // retry can provide. Let the durable stage runner handle those so one
      // user action cannot multiply into nine near-identical AI calls.
      if (response.status === 429 && attempt < 2 && !/(?:联通元景|DeepSeek 官方 API)/.test(source)) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 900 * (attempt + 1)));
        continue;
      }
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        detail = cleanText(parsed?.error?.message || parsed?.reason || parsed?.msg || parsed?.message || (parsed?.code != null ? `code ${parsed.code}` : ""));
      } catch { detail = cleanText(text).slice(0, 160); }
      if (response.status === 429) {
        const error = `${source}请求过于频繁（429）${detail ? `：${detail}` : "，请稍后重试"}`;
        await recordProviderHealth(provider, { ok: false, latencyMs: Date.now() - startedAt, error, rateLimited: true });
        throw new Error(error);
      }
      const error = `${source}返回 ${response.status}${detail ? `：${detail}` : ""}`;
      await recordProviderHealth(provider, { ok: false, latencyMs: Date.now() - startedAt, error });
      throw new Error(error);
    } catch (error: any) {
      if (error?.name === "AbortError") {
        const message = `${source}响应超时`;
        await recordProviderHealth(provider, { ok: false, latencyMs: Date.now() - startedAt, error: message });
        throw new Error(message);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${source}请求失败`);
}

function parseMcpPayload(text: string) {
  const dataLines = text.split(/\r?\n/).filter(line => line.startsWith("data:"));
  const payload = dataLines.length ? dataLines[dataLines.length - 1].slice(5).trim() : text.trim();
  if (!payload) return {};
  return JSON.parse(payload);
}

async function mcpPost(endpoint: string, payload: any, sessionId = "", timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    return { payload: parseMcpPayload(text), sessionId: response.headers.get("mcp-session-id") || sessionId };
  } finally {
    clearTimeout(timer);
  }
}

function parseMcpToolText(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function callMcp(endpoint: string, tool: string, args: any, options: { timeoutMs?: number; cacheMs?: number } = {}) {
  const key = `${endpoint}|${tool}|${JSON.stringify(args)}`;
  const provider = `MCPMarket：${tool}`;
  const cached = mcpMemory.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    await recordProviderHealth(provider, { ok: true, latencyMs: 0, cacheHit: true });
    return cached.value;
  }
  const persisted = await persistentCacheGet("mcp", key);
  if (persisted !== null) {
    mcpMemory.set(key, { expiresAt: Date.now() + (options.cacheMs || 5 * 60 * 1000), value: persisted });
    await recordProviderHealth(provider, { ok: true, latencyMs: 1, cacheHit: true });
    return persisted;
  }
  const timeoutMs = options.timeoutMs || 12000;
  const startedAt = Date.now();
  try {
    const initialized = await mcpPost(endpoint, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smart-travel-cn", version: "1.0.0" } },
    }, "", timeoutMs);
    const sessionId = initialized.sessionId;
    if (!sessionId) throw new Error("MCP 未返回会话标识");
    await mcpPost(endpoint, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId, timeoutMs);
    const called = await mcpPost(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, sessionId, timeoutMs);
    const rpc = called.payload;
    if (rpc?.error) throw new Error(cleanText(rpc.error.message, "MCP 调用失败"));
    const result = rpc?.result || {};
    const textContent = (result.content || []).find((item: any) => item?.type === "text")?.text;
    if (result.isError) throw new Error(cleanText(textContent, `${tool} 返回错误`));
    const value = parseMcpToolText(textContent) ?? result.structuredContent ?? result;
    const cacheMs = options.cacheMs || 5 * 60 * 1000;
    mcpMemory.set(key, { expiresAt: Date.now() + cacheMs, value });
    await persistentCachePut("mcp", key, value, cacheMs);
    await recordProviderHealth(provider, { ok: true, latencyMs: Date.now() - startedAt });
    return value;
  } catch (error: any) {
    const message = cleanText(error?.message, "MCP 调用失败");
    await recordProviderHealth(provider, { ok: false, latencyMs: Date.now() - startedAt, error: message, rateLimited: /429|频繁|额度/.test(message) });
    throw error;
  }
}

export async function fetchTextResource(url: string, init: RequestInit = {}, timeoutMs = 18000, source = "网页读取") {
  const startedAt = Date.now();
  const provider = providerNameFor(url, source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, fetchOptions({ ...init, redirect: "follow", signal: controller.signal }));
    const text = await response.text();
    if (!response.ok) {
      const message = `${source}返回 ${response.status}`;
      await recordProviderHealth(provider, { ok: false, latencyMs: Date.now() - startedAt, error: message, rateLimited: response.status === 429 });
      return { response, text, ok: false };
    }
    await recordProviderHealth(provider, { ok: true, latencyMs: Date.now() - startedAt });
    return { response, text, ok: true };
  } catch (error: any) {
    const message = error?.name === "AbortError" ? `${source}响应超时` : cleanText(error?.message, `${source}网络失败`);
    await recordProviderHealth(provider, { ok: false, latencyMs: Date.now() - startedAt, error: message });
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}
