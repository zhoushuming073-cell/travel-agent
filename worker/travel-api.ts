// @ts-nocheck

import { assertPlanContract } from "./domain/contract.ts";
import { buildPlanningEvents } from "./domain/agent.ts";
import { computeChangeSet } from "./domain/replan.ts";
import { analyzePlanTrustV2 } from "./domain/trust.ts";
import {
  assertPlannerContext,
  auditPlannerDraft,
  mergeDeterministicProfile,
  openingRange,
  parseStrictJsonObject,
  preserveLockedDays,
  settleTravelProviders,
} from "./domain/planner-v4.ts";
import {
  aiApiKey,
  aiEndpoint,
  aiModelCandidates,
  aiPrimaryModel,
  modelFamily,
  type AiPurpose,
} from "./domain/model-routing.ts";
import { deterministicProfileHints, mergeTravelProfile } from "./domain/profile-extraction.ts";
import { summarizeTrafficCoverage } from "./domain/traffic-coverage.ts";
import { crowdRiskForVisit, predictCrowdRisk } from "./domain/crowd-risk.ts";
import {
  acquireTravelJobLease,
  addTravelJobEvent,
  activeJobCount,
  configurePersistence,
  consumeRateLimit,
  createTravelJob,
  findActiveTravelJob,
  getTravelJobArtifact,
  getTravelJob,
  listJobProviderAttempts,
  listTravelJobEvents,
  persistentCacheGet,
  persistentCachePut,
  providerHealthSnapshot,
  putTravelJobArtifact,
  recordJobProviderAttempt,
  recordProviderHealth,
  releaseTravelJobLease,
  renewTravelJobLease,
  requestTravelJobCancellation,
  requestClientHash,
  runtimeMetrics,
  sha256,
  updateTravelJob,
} from "./persistence.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const OSRM = "https://router.project-osrm.org";
const WEATHER_MCP = "https://mcpmarket.cn/mcp/a5be23a7cc256930f8f3ccc6";
const HOTEL_MCP = "https://mcpmarket.cn/mcp/14d52a3200549c758f548f52";
const AMAP_MCP = "https://mcpmarket.cn/mcp/06cbbceb8f161926894c4584";
const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";
const BING_NEWS_RSS = "https://www.bing.com/news/search";
const NEWSNOW_SOURCES = ["weibo", "douyin", "zhihu", "baidu", "toutiao", "thepaper", "tencent-hot"];
const COMMON_CHINA_CITIES = [
  ["北京", 39.9042, 116.4074], ["上海", 31.2304, 121.4737], ["广州", 23.1291, 113.2644],
  ["深圳", 22.5431, 114.0579], ["杭州", 30.2741, 120.1551], ["成都", 30.5728, 104.0668],
  ["重庆", 29.563, 106.5516], ["西安", 34.3416, 108.9398], ["南京", 32.0603, 118.7969],
  ["苏州", 31.2989, 120.5853], ["厦门", 24.4798, 118.0894], ["昆明", 25.0389, 102.7183],
] as const;
const mcpMemory = new Map<string, { expiresAt: number; value: any }>();
const unsplashMemory = new Map<string, { expiresAt: number; value: any }>();
const intelligenceMemory = new Map<string, { expiresAt: number; value: any }>();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

const clamp = (value: unknown, min: number, max: number) =>
  Math.min(max, Math.max(min, Number(value) || min));

const cleanText = (value: unknown, fallback = "") =>
  String(value ?? fallback).replace(/[\u0000-\u001f]+/g, " ").trim();

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
  if (/元景|DeepSeek|联通/.test(source)) return "联通元景 AI";
  return cleanText(source, hostname || "外部服务").slice(0, 80);
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 18000, source = "上游服务") {
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
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 900 * (attempt + 1)));
        continue;
      }
      let detail = "";
      try { detail = cleanText(JSON.parse(text)?.error?.message || JSON.parse(text)?.reason); } catch { detail = cleanText(text).slice(0, 160); }
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

async function callMcp(endpoint: string, tool: string, args: any, options: { timeoutMs?: number; cacheMs?: number } = {}) {
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

function dateString(value: unknown, fallback = new Date().toISOString().slice(0, 10)) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function addDays(iso: string, offset: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function diffDays(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function weekday(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

function minutesToTime(total: number) {
  const safe = Math.max(0, Math.round(total));
  return `${String(Math.floor(safe / 60) % 24).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function timeToMinutes(text: unknown, fallback: number) {
  const match = cleanText(text).match(/(\d{1,2}):(\d{2})/);
  return match ? clamp(Number(match[1]) * 60 + Number(match[2]), 0, 1439) : fallback;
}

function list(value: unknown) {
  return Array.isArray(value) ? value.map(item => cleanText(item)).filter(Boolean) : [];
}

function normalizeName(name: unknown) {
  return cleanText(name).replace(/[\s·•—－()（）景区风景名胜区旅游区]+/g, "").toLowerCase();
}

function secureImageUrl(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:") return parsed.href;
    if (parsed.protocol === "http:" && /(^|\.)(autonavi|amap)\.com$/i.test(parsed.hostname)) {
      parsed.protocol = "https:";
      return parsed.href;
    }
  } catch { /* invalid image URL */ }
  return "";
}

function imageLookupNames(name: string, city = "") {
  const values = [cleanText(name)];
  const withoutSuffix = cleanText(name).replace(/(?:风景名胜区|旅游景区|景区|公园)$/g, "");
  if (withoutSuffix && withoutSuffix !== name) values.push(withoutSuffix);
  if (/江滩.*水上乐园/.test(name)) values.push(name.replace(/水上乐园.*$/, ""));
  if (/铁路轮渡船/.test(name)) values.push(`${city || "武汉"}轮渡`);
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function poiMatchScore(actualName: unknown, wantedNames: string[]) {
  const actual = normalizeName(actualName);
  if (!actual) return 0;
  return wantedNames.reduce((best, wantedName) => {
    const wanted = normalizeName(wantedName);
    if (!wanted) return best;
    if (actual === wanted) return Math.max(best, 100);
    if (actual.startsWith(wanted) || wanted.startsWith(actual)) return Math.max(best, 85);
    if (actual.includes(wanted) || wanted.includes(actual)) return Math.max(best, 70);
    return best;
  }, 0);
}

export function poiImageScore(poi: any, wantedNames: string[]) {
  const match = poiMatchScore(poi?.name, wantedNames);
  if (!match) return 0;
  const type = cleanText(poi?.type || poi?.typeName || poi?.category);
  if (/商务住宅|公司企业|餐饮服务|政府机构|医疗保健|汽车服务|生活服务/.test(type)) return 0;
  const childPenalty = /(?:内园|艺术中心|分馆|售票处|游客中心|服务中心|停车场|入口|出口)$/i.test(cleanText(poi?.name)) ? 38 : 0;
  if (/风景名胜|公园广场|科教文化服务|特色商业街|自然地名|文物古迹/.test(type)) return match + 25 - childPenalty;
  return match === 100 ? match - childPenalty : 0;
}

function parseJsonObject(text: string) {
  try { return parseStrictJsonObject(text); }
  catch {
    const source = String(text ?? "");
    const start = source.indexOf("{");
    if (start < 0) throw new Error("DeepSeek 未返回有效 JSON 对象");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return parseStrictJsonObject(source.slice(start, index + 1));
      }
    }
    throw new Error("DeepSeek 返回的 JSON 被截断");
  }
}

async function searchVerifiedTravelContext(query: string, city: string, env: any) {
  const fetchedAt = new Date().toISOString();
  const normalizedQuery = cleanText(query);
  const normalizedCity = cleanText(city);
  const wikiParams = new URLSearchParams({
    action: "query", format: "json", origin: "*", list: "search", utf8: "1", srlimit: "6",
    srsearch: `${normalizedQuery} ${normalizedCity} 旅游`,
  });
  const nominatimParams = new URLSearchParams({
    q: `${normalizedQuery}, ${normalizedCity}, 中国`, format: "jsonv2", addressdetails: "1",
    extratags: "1", namedetails: "1", limit: "6", countrycodes: "cn", "accept-language": "zh-CN",
  });
  const providerRequests: Record<string, Promise<any>> = {
    wikipedia: fetchJson(`https://zh.wikipedia.org/w/api.php?${wikiParams}`, {}, 12000, "Wikimedia 联网检索"),
    amap: callMcp(AMAP_MCP, "maps_text_search", { keywords: normalizedQuery, city: normalizedCity, types: "风景名胜|公园广场|科教文化服务|餐饮服务|住宿服务" }, { timeoutMs: 10000, cacheMs: 20 * 60 * 1000 }),
    nominatim: fetchJson(`${NOMINATIM}/search?${nominatimParams}`, {}, 15000, "OSM/Nominatim 联网核验"),
  };
  const officialKey = cleanText(env?.AMAP_WEB_KEY);
  if (officialKey) {
    const amapParams = new URLSearchParams({
      key: officialKey, keywords: normalizedQuery, city: normalizedCity, citylimit: "true",
      types: "风景名胜|公园广场|科教文化服务|餐饮服务|住宿服务", extensions: "all", offset: "10", page: "1",
    });
    providerRequests.amapOfficial = fetchJson(`https://restapi.amap.com/v3/place/text?${amapParams}`, {}, 15000, "高德官方联网核验");
  }
  const providers = await settleTravelProviders(providerRequests);
  const wikiRows = providers.wikipedia.status === "ready" ? (providers.wikipedia.data as any)?.query?.search || [] : [];
  const amapRows = providers.amap.status === "ready" ? amapPoiRows(providers.amap.data).slice(0, 6) : [];
  const officialRows = providers.amapOfficial?.status === "ready" && String((providers.amapOfficial.data as any)?.status) === "1" ? amapPoiRows(providers.amapOfficial.data).slice(0, 6) : [];
  const osmRows = providers.nominatim.status === "ready" && Array.isArray(providers.nominatim.data) ? providers.nominatim.data.slice(0, 6) : [];
  return {
    query: normalizedQuery, city: normalizedCity, fetchedAt,
    sources: [
      ...wikiRows.map((row: any) => ({ name: cleanText(row.title), snippet: cleanText(row.snippet).replace(/<[^>]+>/g, ""), source: "中文维基百科", url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(cleanText(row.title).replace(/ /g, "_"))}`, status: "public-context" })),
      ...officialRows.map((row: any) => ({ name: cleanText(row.name), address: cleanText(row.address), type: cleanText(row.type), location: cleanText(row.location), source: "高德地图官方 Web 服务", url: row.id ? `https://www.amap.com/place/${encodeURIComponent(cleanText(row.id))}` : null, status: "map-poi" })),
      ...amapRows.map((row: any) => ({ name: cleanText(row.name), address: cleanText(row.address), type: cleanText(row.type), location: cleanText(row.location), source: "高德地图 MCP", status: "map-poi" })),
      ...osmRows.map((row: any) => ({ name: cleanText(row.display_name || row.name), address: cleanText(row.display_name), type: cleanText(row.type || row.class), location: `${cleanText(row.lon)},${cleanText(row.lat)}`, source: "OpenStreetMap / Nominatim", url: `https://www.openstreetmap.org/${cleanText(row.osm_type)}/${cleanText(row.osm_id)}`, status: "map-entity" })),
    ],
    unavailable: Object.entries(providers).filter(([, value]: any) => value.status === "unavailable").map(([name, value]: any) => ({ name, reason: value.error })),
    note: "联网工具仅返回可追溯的公开页面与地图 POI；未返回的开放、预约、客流和价格信息继续保持 Unknown。",
  };
}

async function aiRequest(env: any, options: {
  purpose: AiPurpose;
  messages: any[];
  jsonMode?: boolean;
  thinking?: boolean;
  allowReasoningOnly?: boolean;
  maxTokens?: number;
  requestTimeoutMs?: number;
  webTools?: { city: string } | null;
}) {
  const key = aiApiKey(env);
  if (!key) throw new Error("部署环境尚未配置联通元景 API Key");
  const candidates = aiModelCandidates(env, options.purpose);
  const failures: string[] = [];
  for (const model of candidates) {
    const messages = structuredClone(options.messages);
    const toolLog: any[] = [];
    const tools = options.webTools ? [{
      type: "function",
      function: {
        name: "search_verified_travel_context",
        description: "联网查询中国目的地的公开旅游实体和地图 POI。在需要核验景点实体、季节背景或关联位置时调用。不得把搜索摘要冒充实时客流、预约、开放或价格。",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "要核验的景点、季节现象或旅行实体，2—80 字" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    }] : undefined;
    try {
      for (let turn = 0; turn < 4; turn += 1) {
        const payload: any = {
          model,
          messages,
          max_tokens: options.maxTokens || 6000,
          stream: false,
          chat_template_kwargs: { enable_thinking: Boolean(options.thinking) },
        };
        if (options.jsonMode && !options.thinking) payload.response_format = { type: "json_object" };
        if (!options.thinking) payload.temperature = options.jsonMode ? 0.1 : 0.25;
        // One auditable search round is enough: the model may request up to three
        // queries in that round, then it must synthesize from the returned evidence.
        if (tools && toolLog.length === 0) { payload.tools = tools; payload.tool_choice = "auto"; }
        const longRunning = options.thinking || options.purpose === "planner" || options.purpose === "repair";
        const result = await fetchJson(aiEndpoint(env), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(payload),
        }, options.requestTimeoutMs || (longRunning ? 120000 : 60000), `联通元景 ${model}`);
        const message = result?.choices?.[0]?.message;
        if (!message) throw new Error(`联通元景 ${model} 没有返回消息`);
        const content = cleanText(message.content);
        const reasoningContent = cleanText(message.reasoning_content);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (content && (toolLog.length > 0 || !calls.length || cleanText(result?.choices?.[0]?.finish_reason) !== "tool_calls")) {
          return { content, reasoningContent, model: cleanText(result?.model, model), toolLog, attemptedModels: [...failures, model] };
        }
        if (options.allowReasoningOnly && reasoningContent && !calls.length) return { content: "", reasoningContent, model: cleanText(result?.model, model), toolLog, attemptedModels: [...failures, model] };
        if (!calls.length) throw new Error(`联通元景 ${model} 没有返回内容`);
        messages.push({ role: "assistant", content: message.content ?? "", reasoning_content: message.reasoning_content ?? "", tool_calls: message.tool_calls });
        for (const call of calls.slice(0, 3)) {
          let args: any = {};
          try { args = JSON.parse(cleanText(call?.function?.arguments, "{}")); } catch { args = {}; }
          const query = cleanText(args.query).slice(0, 80);
          const output = query.length >= 2
            ? await searchVerifiedTravelContext(query, options.webTools?.city || "", env)
            : { error: "query 必须为 2—80 字", sources: [] };
          toolLog.push({
            tool: "search_verified_travel_context", query,
            resultCount: output.sources?.length || 0,
            fetchedAt: output.fetchedAt || new Date().toISOString(),
            sources: (output.sources || []).slice(0, 6).map((source: any) => ({ name: cleanText(source.name), provider: cleanText(source.source), url: cleanText(source.url) || null })),
            unavailable: output.unavailable || [],
          });
          messages.push({ role: "tool", tool_call_id: cleanText(call.id), content: JSON.stringify(output) });
        }
      }
      throw new Error(`${model} 联网工具调用超过安全上限`);
    } catch (error: any) {
      failures.push(`${model}: ${cleanText(error?.message, "请求失败")}`);
    }
  }
  throw new Error(`联通元景模型均不可用：${failures.join("；")}`);
}

async function aiJson(env: any, options: Parameters<typeof aiRequest>[1]) {
  const first = await aiRequest(env, { ...options, jsonMode: true });
  try { return { value: parseJsonObject(first.content), model: first.model, toolLog: first.toolLog, formatRepaired: false }; }
  catch {
    const repaired = await aiRequest(env, {
      purpose: options.purpose,
      thinking: false,
      maxTokens: options.maxTokens,
      jsonMode: true,
      messages: [
        { role: "system", content: "你是 JSON 格式修复器。只修复语法和字段容器，不添加新事实。只输出一个有效 JSON 对象。" },
        { role: "user", content: first.content },
      ],
    });
    return { value: parseJsonObject(repaired.content), model: repaired.model, toolLog: first.toolLog, formatRepaired: true };
  }
}

async function extractProfile(input: any, env: any) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const hints = deterministicProfileHints(cleanText(input.freeText));
  const prompt = `请把用户的中国旅行需求整理成严格 json。用户原文是事实提取的第一优先级；当前表单只是原文没提到字段时的默认参数，绝不能用表单默认人数、日期、天数覆盖原文。支持中文数字以及“8.25出发”“8月25日”“明天出发”等口语日期；没有年份时按中国时区、相对今天 ${today} 推断最近的未过日期。只提取用户明确表达或可直接计算的信息，不虚构景点、客流、预约、天气、酒店价格。用户明确说“想去/希望去/必须去”的地点属于 requiredAttractions，普通兴趣偏好不得提升为必去。\n字段：city,startDate(YYYY-MM-DD),days,nights,partySize,adults,children,seniors,budget,budgetLevel,style,preferences(string[]),interestPriorities([{name,priority}]),avoid(string[]),requiredAttractions(string[]),excludedAttractions(string[]),pace,transport,hotelPreference,lodgingArea,dayStart(HH:mm),dayEnd(HH:mm),mealPreference,crowdSensitivity,weatherSensitivity,walkingSensitivity,seasonalNeeds(string[]),requestedVariants(string[]),returnTime,unknownFields(string[]),clarificationNeeded(boolean),clarificationQuestion(string)。未明确字段填 "Unknown" 或放入 unknownFields，不得自行猜测。当前规划器一次只支持一个明确城市或区县。\n当前表单（仅作缺省值）：${JSON.stringify({ ...input, freeText: undefined })}\n用户原文（最高优先级）：${cleanText(input.freeText)}`;
  let extracted: any;
  try {
    extracted = await aiJson(env, {
      purpose: "extract", thinking: false, maxTokens: 3200,
      messages: [
        { role: "system", content: "你是旅行需求结构化助手。只输出一个 JSON 对象，不输出解释。" },
        { role: "user", content: prompt },
      ],
    });
  } catch (error: any) {
    const hasCoreTextFields = Boolean((hints.city || cleanText(input.city)) && hints.startDate && hints.days && hints.partySize);
    if (!hasCoreTextFields) throw error;
    extracted = {
      value: {},
      model: "deepseek-v4-flash（限流时文本规则兜底）",
      formatRepaired: false,
      fallbackReason: cleanText(error?.message, "需求模型暂不可用"),
    };
  }
  const merged = mergeDeterministicProfile(hints, extracted.value);
  return { ...mergeTravelProfile(input, merged), extractionModel: extracted.model, extractionFormatRepaired: extracted.formatRepaired, extractionFallbackReason: extracted.fallbackReason || "" };
}

function adminBaseName(value: unknown) {
  return cleanText(value).replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|市|区|县|盟|旗)$/u, "");
}

export function selectBestAmapDistrict(query: string, districts: any[]) {
  const wanted = cleanText(query);
  const wantedBase = adminBaseName(wanted);
  const explicitSuffix = /(?:特别行政区|自治区|自治州|地区|市|区|县|盟|旗)$/u.test(wanted);
  return [...districts]
    .filter((row) => cleanText(row?.name) && cleanText(row?.center))
    .map((row) => {
      const name = cleanText(row.name);
      const level = cleanText(row.level);
      const exact = name === wanted;
      const cityForm = name === `${wantedBase}市`;
      const sameBase = adminBaseName(name) === wantedBase;
      const levelScore = explicitSuffix
        ? (exact ? 80 : 0)
        : level === "city" ? 45 : level === "province" ? 25 : level === "district" ? 5 : 0;
      return { row, score: (exact ? 100 : 0) + (cityForm ? 70 : 0) + (sameBase ? 50 : 0) + levelScore };
    })
    .sort((left, right) => right.score - left.score)[0]?.row || null;
}

async function searchCities(query: string, limit = 8, env: any = null) {
  if (cleanText(query).length < 2) return [];
  const normalizedQuery = cleanText(query).replace(/市$/, "");
  const cached = await persistentCacheGet("china-city-v3", normalizedQuery).catch(() => null);
  if (Array.isArray(cached) && cached.length) return cached.slice(0, limit);
  const officialKey = cleanText(env?.AMAP_WEB_KEY);
  if (officialKey) {
    try {
      const queryVariants = /(?:特别行政区|自治区|自治州|地区|市|区|县|盟|旗)$/u.test(cleanText(query))
        ? [cleanText(query)]
        : [`${normalizedQuery}市`, normalizedQuery];
      const districtResponses = await Promise.allSettled(queryVariants.map(async (keywords) => {
        const districtParams = new URLSearchParams({ key: officialKey, keywords, subdistrict: "0", extensions: "base" });
        return fetchJson(`https://restapi.amap.com/v3/config/district?${districtParams}`, {}, 12000, `高德行政区查询“${keywords}”`);
      }));
      const districts = districtResponses.flatMap((result: any) => result.status === "fulfilled" && String(result.value?.status) === "1" ? result.value?.districts || [] : []);
      const district = selectBestAmapDistrict(cleanText(query), districts);
      const [lng, lat] = cleanText(district?.center).split(",").map(Number);
      if (district && Number.isFinite(lat) && Number.isFinite(lng)) {
        const result = [{
          name: cleanText(district.name).replace(/市$/, ""), displayName: `${cleanText(district.name)}，中国`,
          lat, lng, zoom: district.level === "district" ? 12 : 11, countryCode: "cn",
          adcode: cleanText(district.adcode), citycode: cleanText(district.citycode), administrativeLevel: cleanText(district.level),
          source: "高德地图官方行政区数据库",
        }];
        await persistentCachePut("china-city-v3", normalizedQuery, result, 7 * 24 * 60 * 60 * 1000).catch(() => undefined);
        return result;
      }
    } catch { /* 继续使用常用城市与公开地理服务 */ }
  }
  const common = COMMON_CHINA_CITIES.find(([name]) => name === normalizedQuery);
  if (common) {
    const result = [{ name: common[0], displayName: `${common[0]}，中国`, lat: common[1], lng: common[2], zoom: 11, countryCode: "cn", adcode: null, source: "常用城市稳定坐标" }];
    await persistentCachePut("china-city-v3", normalizedQuery, result, 7 * 24 * 60 * 60 * 1000).catch(() => undefined);
    return result;
  }
  const geoParams = new URLSearchParams({ name: cleanText(query), count: String(limit), language: "zh", format: "json", countryCode: "CN" });
  let geoData: any = {};
  try { geoData = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${geoParams}`, {}, 15000, "Open-Meteo 城市搜索"); } catch { geoData = {}; }
  const seen = new Set<string>();
  const cities = (geoData?.results || []).map((row: any) => {
    const name = cleanText(row.name || query).replace(/市$/, "");
    return {
      name,
      displayName: [row.name, row.admin1, row.admin2, row.country].filter(Boolean).join("，"),
      lat: Number(row.latitude), lng: Number(row.longitude), zoom: 11, countryCode: "cn",
      geonameId: row.id, source: "Open-Meteo Geocoding",
    };
  }).filter((row: any) => row.name && Number.isFinite(row.lat) && !seen.has(row.name) && seen.add(row.name));
  if (cities.length) {
    await persistentCachePut("china-city-v3", normalizedQuery, cities, 7 * 24 * 60 * 60 * 1000).catch(() => undefined);
    return cities;
  }
  const params = new URLSearchParams({ q: `${query}, 中国`, format: "jsonv2", addressdetails: "1", limit: String(Math.min(limit, 5)), countrycodes: "cn", "accept-language": "zh-CN" });
  let data: any[] = [];
  try { data = await fetchJson(`${NOMINATIM}/search?${params}`, {}, 18000, "OSM 城市搜索"); } catch { data = []; }
  const results = (Array.isArray(data) ? data : []).map((row: any) => {
    const address = row.address || {};
    const name = cleanText(address.city || address.town || address.county || address.state_district || row.name || query).replace(/市$/, "");
    return { name, displayName: cleanText(row.display_name), lat: Number(row.lat), lng: Number(row.lon), zoom: 11, countryCode: "cn", osmType: row.osm_type, osmId: row.osm_id, source: "OSM Nominatim" };
  }).filter((row: any) => row.name && Number.isFinite(row.lat) && !seen.has(row.name) && seen.add(row.name));
  await persistentCachePut("china-city-v3", normalizedQuery, results, 7 * 24 * 60 * 60 * 1000).catch(() => undefined);
  return results;
}

async function resolveCity(name: string, env: any = null) {
  const results = await searchCities(name, 5, env);
  if (!results.length) throw new Error(`未在中国范围内验证到目的地“${name}”`);
  const exact = results.find((item: any) => normalizeName(item.name) === normalizeName(name));
  return exact || results[0];
}

async function weatherDirect(city: any, startDate: string, days: number) {
  const params = new URLSearchParams({
    latitude: String(city.lat), longitude: String(city.lng), timezone: "Asia/Shanghai",
    current: "temperature_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    forecast_days: "16",
  });
  const raw = await fetchJson(`${OPEN_METEO}?${params}`, {}, 18000, "Open-Meteo 天气服务");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const tripForecast = Array.from({ length: days }, (_, index) => {
    const date = addDays(startDate, index);
    const idx = raw?.daily?.time?.indexOf(date) ?? -1;
    if (idx < 0) return { date, quality: "unavailable", note: diffDays(today, date) > 15 ? "出行日期超过当前逐日预报范围；未用今日天气替代" : "该日期暂无逐日预报" };
    return {
      date, quality: "forecast", weatherCode: raw.daily.weather_code[idx],
      temperatureMax: raw.daily.temperature_2m_max[idx], temperatureMin: raw.daily.temperature_2m_min[idx],
      precipitationProbability: raw.daily.precipitation_probability_max[idx],
      sunrise: cleanText(raw.daily.sunrise?.[idx]).slice(11, 16) || null,
      sunset: cleanText(raw.daily.sunset?.[idx]).slice(11, 16) || null,
      source: "Open-Meteo",
    };
  });
  return { city: city.name, current: raw.current || {}, tripForecast, fetchedAt: new Date().toISOString(), source: "Open-Meteo" };
}

async function weatherFor(city: any, startDate: string, days: number) {
  const astronomicalPromise = weatherDirect(city, startDate, days).catch(() => null);
  try {
    const raw: any = await callMcp(WEATHER_MCP, "get_weather_forecast", {
      latitude: Number(city.lat), longitude: Number(city.lng), days: Math.min(16, Math.max(3, days)),
      hourly_vars: "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
    }, { timeoutMs: 16000, cacheMs: 20 * 60 * 1000 });
    const hourly = raw?.hourly || {};
    const rows = (hourly.time || []).map((time: string, index: number) => ({
      time, temperature: Number(hourly.temperature_2m?.[index]), precipitation: Number(hourly.precipitation_probability?.[index]),
      code: Number(hourly.weather_code?.[index]), wind: Number(hourly.wind_speed_10m?.[index]),
    }));
    if (!rows.length) throw new Error("天气 MCP 未返回逐小时预报");
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const tripForecast = Array.from({ length: days }, (_, offset) => {
      const date = addDays(startDate, offset);
      const dayRows = rows.filter((row: any) => row.time.startsWith(date));
      if (!dayRows.length) return { date, quality: "unavailable", note: diffDays(today, date) > 15 ? "出行日期超出当前逐日预报范围；未用今日天气替代" : "该日期暂时没有逐日预报" };
      const temperatures = dayRows.map((row: any) => row.temperature).filter(Number.isFinite);
      const precipitations = dayRows.map((row: any) => row.precipitation).filter(Number.isFinite);
      const noon = dayRows.find((row: any) => row.time.endsWith("T12:00")) || dayRows[Math.floor(dayRows.length / 2)];
      return {
        date, quality: "forecast", weatherCode: Number(noon?.code || 0),
        temperatureMax: Math.max(...temperatures), temperatureMin: Math.min(...temperatures),
        precipitationProbability: precipitations.length ? Math.max(...precipitations) : 0,
        source: "MCPMarket 天气查询 / Open-Meteo",
      };
    });
    const astronomical: any = await astronomicalPromise;
    const mergedForecast = tripForecast.map((day: any, index: number) => ({
      ...day,
      sunrise: astronomical?.tripForecast?.[index]?.sunrise || null,
      sunset: astronomical?.tripForecast?.[index]?.sunset || null,
    }));
    return { city: city.name, current: astronomical?.current || {}, tripForecast: mergedForecast, fetchedAt: new Date().toISOString(), source: "MCPMarket 天气查询 + Open-Meteo 日照时间", mcpStatus: "ready" };
  } catch (error: any) {
    const fallback: any = await astronomicalPromise || await weatherDirect(city, startDate, days);
    fallback.source = "Open-Meteo 直连兜底";
    fallback.mcpStatus = "fallback";
    fallback.mcpNote = cleanText(error?.message, "天气 MCP 暂不可用");
    fallback.tripForecast = (fallback.tripForecast || []).map((day: any) => ({ ...day, source: day.quality === "forecast" ? "Open-Meteo 直连兜底" : day.source }));
    return fallback;
  }
}

function category(tags: any) {
  if (tags.natural || tags.leisure === "park" || tags.tourism === "viewpoint") return "自然景观";
  if (tags.historic || tags.amenity === "place_of_worship") return "历史文化";
  if (tags.tourism === "museum" || tags.amenity === "arts_centre") return "博物展馆";
  return "景点";
}

function poiFromElement(element: any, requiredByUser = false) {
  const tags = element.tags || {};
  const center = element.center || element;
  const name = cleanText(tags["name:zh"] || tags.name);
  const id = `osm-${element.type}-${element.id}`;
  return {
    id, name, lat: Number(center.lat), lng: Number(center.lon), category: category(tags),
    durationMin: tags.tourism === "museum" ? 120 : tags.leisure === "park" ? 100 : 90,
    openingHours: cleanText(tags.opening_hours), website: cleanText(tags.website || tags["contact:website"]),
    wikipedia: cleanText(tags.wikipedia), wikidata: cleanText(tags.wikidata), wikimediaCommons: cleanText(tags.wikimedia_commons), image: cleanText(tags.image),
    staticPoiQuality: tags.wikidata || tags.wikipedia || tags.website ? "较高" : "基础",
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    fetchedAt: new Date().toISOString(), requiredByUser,
    crowd: { score: null, label: "未知", source: "未接入可验证官方客流" },
    openingStatus: { status: "unknown", label: tags.opening_hours ? `规则：${tags.opening_hours}` : "开放时间未知，出发前请复核" },
    recommendationReasons: requiredByUser ? ["用户明确指定的必选项", "已通过地图公开数据核验"] : ["来自 OpenStreetMap 的公开地点数据"],
    transitStops: [],
  };
}

function wikiCategory(title: string, extract: string) {
  const text = `${title} ${extract}`;
  if (/湖|山|峰|洞|瀑布|湿地|公园|花园|园林|岛|堤|自然保护区|风景区/.test(text)) return "自然景观";
  if (/博物馆|美术馆|纪念馆|展览馆|科技馆/.test(text)) return "博物展馆";
  if (/寺|庙|塔|教堂|故居|遗址|古镇|古城|祠|陵|历史|文化遗产|世界遗产/.test(text)) return "历史文化";
  return "城市景观";
}

function wikiPageToSpot(page: any, city: any, requiredNames: string[], preferences: string[] = []) {
  const coordinate = page?.coordinates?.[0];
  if (!coordinate || !Number.isFinite(Number(coordinate.lat)) || !Number.isFinite(Number(coordinate.lon))) return null;
  const name = cleanText(page.title);
  const extract = cleanText(page.extract);
  const text = `${name} ${extract}`;
  const requiredByUser = requiredNames.some(required => {
    const wanted = normalizeName(required), actual = normalizeName(name);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
  const familyEntertainmentWanted = preferences.some(item => /亲子|乐园|游乐|水上/.test(item));
  if (/街道办事处|行政区|市辖区|下辖|地铁|车站|铁路|高速公路|国道|省道|医院|学校|大学|住宅区|写字楼|公司总部|机场/.test(text)) return null;
  if (!requiredByUser && /铁路轮渡船/.test(text)) return null;
  if (!requiredByUser && !familyEntertainmentWanted && /水上乐园|游乐园/.test(text)) return null;
  if (/^[\u4e00-\u9fa5]{2,10}(市|区|县|省)$/.test(name)) return null;
  if (!/景区|景点|公园|博物馆|美术馆|纪念馆|故居|遗址|古镇|古村|寺|庙|塔|湖|山|峰|洞|瀑布|湿地|花园|园林|宫|祠|陵|古城|历史文化|世界遗产|风景|自然保护区|教堂|广场|动物园|植物园|水库|岛|堤|桥|街区|宋城/.test(text)) return null;
  const lat = Number(coordinate.lat), lng = Number(coordinate.lon);
  if (haversine(city.lat, city.lng, lat, lng) > 80000) return null;
  return {
    id: `wikipedia-${page.pageid}`, name, lat, lng, category: requiredByUser ? "用户必选" : wikiCategory(name, extract),
    durationMin: /博物馆|美术馆|纪念馆|宋城/.test(text) ? 120 : /公园|湖|山|湿地|风景区/.test(text) ? 110 : 90,
    openingHours: "", website: "", wikipedia: `zh:${name}`, wikidata: cleanText(page?.pageprops?.wikibase_item),
    wikimediaCommons: "", image: cleanText(page?.thumbnail?.source),
    staticPoiQuality: "百科坐标已核验", sourceUrl: `https://zh.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, "_"))}`,
    fetchedAt: new Date().toISOString(), requiredByUser,
    crowd: { score: null, label: "未知", source: "未接入可验证官方客流" },
    openingStatus: { status: "unknown", label: "开放时间未知，出发前请复核" },
    recommendationReasons: requiredByUser ? ["用户明确指定的必选项", "已通过中文维基百科坐标核验"] : ["中文维基百科公开页面及坐标已核验", extract.slice(0, 70) || "公开百科地点"],
    transitStops: [], extract,
  };
}

export function fallbackPoiCategory(value: string) {
  if (/博物馆|美术馆|展览|纪念馆/.test(value)) return "博物展馆";
  if (/寺|庙|塔|古迹|遗址|故居|历史|文化|城墙|钟楼|鼓楼|古城/.test(value)) return "历史文化";
  if (/公园|湖|山|湿地|自然|风景|植物/.test(value)) return "自然景观";
  return "城市景观";
}

export function isExcludedCandidatePoi(name: string, poiType: string, requiredByUser = false) {
  if (requiredByUser) return false;
  const text = `${cleanText(name)} ${cleanText(poiType)}`;
  if (/建设中|施工中|暂未开放|尚未开放|永久关闭|停止营业/.test(text)) return true;
  if (/学校|幼儿园|小学|中学|大学|学院|培训机构|教育辅导|驾校/.test(text)) return true;
  if (/停车场|卫生间|售票处|游客中心|服务区|入口广场|主入口|出口|打卡地/.test(text)) return true;
  if (/购物服务|商务住宅|公司企业|医疗保健|汽车服务|金融保险/.test(poiType)) return true;
  return false;
}

function amapCandidateRecord(row: any, city: any, requiredNames: string[]) {
  const name = cleanText(row?.name || row?.title);
  const poiType = cleanText(row?.type || row?.typeName || row?.category);
  const location = cleanText(row?.location);
  const [lng, lat] = location.split(",").map(Number);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || haversine(city.lat, city.lng, lat, lng) > 80000) return null;
  const requiredByUser = requiredNames.some(required => {
    const wanted = normalizeName(required), actual = normalizeName(name);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
  if (isExcludedCandidatePoi(name, poiType, requiredByUser)) return null;
  if (/生活服务|摄影冲印|购物服务|商务住宅|公司企业|医疗保健|汽车服务|金融保险/.test(poiType) && !/景区|景点|公园|博物馆|美术馆|纪念馆|故居|遗址|古镇|寺|庙|塔|湖|山|湿地|街区/.test(name)) return null;
  if (/照相馆|摄影工作室|眼镜|密室|剧本杀|购物城.*店|商场.*店|公司$|医院$|诊所$/.test(name)) return null;
  const rating = Number(row?.biz_ext?.rating || row?.business?.rating || row?.rating || 0) || null;
  return {
    id: `amap-${cleanText(row.id, `${lat}-${lng}`)}`, name, lat, lng,
    category: requiredByUser ? "用户必选" : fallbackPoiCategory(`${name} ${poiType}`), poiType,
    durationMin: /博物馆|美术馆|纪念馆/.test(name) ? 120 : /公园|湖|山|湿地|风景/.test(name) ? 110 : 90,
    openingHours: cleanText(row.business?.opentime_today || row.opentime || row.opening_hours), rating,
    website: cleanText(row.website), staticPoiQuality: rating && rating >= 4 ? "较高" : "一般",
    sourceUrl: row.id ? `https://www.amap.com/place/${encodeURIComponent(row.id)}` : "https://www.amap.com/",
    fetchedAt: new Date().toISOString(), requiredByUser,
    crowd: { score: null, label: "未知", source: "未接入可验证官方客流" },
    openingStatus: { status: "unknown", label: "开放时间需在出发前通过官方来源复核" },
    recommendationReasons: requiredByUser ? ["用户明确指定的必选项", "已通过高德地图 POI 坐标核验"] : ["中文维基不可用时由高德地图 POI 真实兜底"],
    transitStops: [], address: cleanText(row.address), image: "",
  };
}

function nominatimCandidateRecord(row: any, city: any, requiredNames: string[]) {
  const name = cleanText(row?.name || row?.display_name?.split(",")?.[0]);
  const lat = Number(row?.lat), lng = Number(row?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || haversine(city.lat, city.lng, lat, lng) > 80000) return null;
  const requiredByUser = requiredNames.some(required => {
    const wanted = normalizeName(required), actual = normalizeName(name);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
  return {
    id: `nominatim-${cleanText(row.osm_type)}-${cleanText(row.osm_id, `${lat}-${lng}`)}`, name, lat, lng,
    category: requiredByUser ? "用户必选" : fallbackPoiCategory(`${name} ${cleanText(row.type)} ${cleanText(row.category)}`),
    durationMin: /博物馆|美术馆|纪念馆/.test(name) ? 120 : /公园|湖|山|湿地|风景/.test(name) ? 110 : 90,
    openingHours: cleanText(row.extratags?.opening_hours), website: cleanText(row.extratags?.website),
    wikipedia: cleanText(row.extratags?.wikipedia), wikidata: cleanText(row.extratags?.wikidata),
    staticPoiQuality: "OSM/Nominatim 坐标已核验",
    sourceUrl: row.osm_type && row.osm_id ? `https://www.openstreetmap.org/${row.osm_type}/${row.osm_id}` : "https://nominatim.openstreetmap.org/",
    fetchedAt: new Date().toISOString(), requiredByUser,
    crowd: { score: null, label: "未知", source: "未接入可验证官方客流" },
    openingStatus: { status: "unknown", label: "开放时间需在出发前通过官方来源复核" },
    recommendationReasons: requiredByUser ? ["用户明确指定的必选项", "已通过 OSM/Nominatim 坐标核验"] : ["中文维基不可用时由 OSM/Nominatim 真实兜底"],
    transitStops: [], address: cleanText(row.display_name), image: "",
  };
}

async function fallbackCandidateSpots(city: any, requiredNames: string[], preferences: string[], env: any = null) {
  const keywords = [...requiredNames, "旅游景点", "公园", "博物馆", "历史文化", ...preferences.slice(0, 2)].filter(Boolean);
  const officialKey = cleanText(env?.AMAP_WEB_KEY);
  const officialCalls = officialKey ? keywords.map(keyword => {
    const params = new URLSearchParams({ key: officialKey, keywords: keyword, city: city.adcode || city.name, citylimit: "true", types: "110000|110100|110200|140100|140200|140400|140600|140700", extensions: "all", offset: "25", page: "1" });
    return fetchJson(`https://restapi.amap.com/v3/place/text?${params}`, {}, 15000, `高德官方景点兜底“${keyword}”`);
  }) : [];
  const officialResults = await Promise.allSettled(officialCalls);
  const officialSpots = officialResults
    .flatMap(result => result.status === "fulfilled" && String(result.value?.status) === "1" ? amapPoiRows(result.value) : [])
    .map((row, providerRank) => {
      const spot = amapCandidateRecord(row, city, requiredNames);
      return spot ? { ...spot, providerRank } : null;
    })
    .filter(Boolean);
  const officialUnique = uniqueSpots(officialSpots);
  if (officialUnique.length >= Math.max(12, requiredNames.length + 6)) return officialUnique;

  const amapCalls = keywords.map(keyword => callMcp(AMAP_MCP, "maps_text_search", {
    keywords: keyword, city: city.name, types: "风景名胜|公园广场|科教文化服务",
  }, { timeoutMs: 10000, cacheMs: 30 * 60 * 1000 }));
  const nominatimQueries = [...requiredNames, `${city.name} 旅游景点`, `${city.name} 公园`, `${city.name} 博物馆`, `${city.name} 古迹`];
  const nominatimCalls = nominatimQueries.map(query => {
    const params = new URLSearchParams({ q: `${query}, 中国`, format: "jsonv2", addressdetails: "1", extratags: "1", namedetails: "1", limit: "10", countrycodes: "cn", "accept-language": "zh-CN" });
    return fetchJson(`${NOMINATIM}/search?${params}`, {}, 16000, `OSM/Nominatim 景点兜底“${query}”`);
  });
  const [amapResults, nominatimResults] = await Promise.all([
    Promise.allSettled(amapCalls), Promise.allSettled(nominatimCalls),
  ]);
  const amapSpots = amapResults
    .flatMap(result => result.status === "fulfilled" ? amapPoiRows(result.value) : [])
    .map((row, providerRank) => {
      const spot = amapCandidateRecord(row, city, requiredNames);
      return spot ? { ...spot, providerRank } : null;
    })
    .filter(Boolean);
  const nominatimSpots = nominatimResults.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []).map(row => nominatimCandidateRecord(row, city, requiredNames)).filter(Boolean);
  return uniqueSpots([...officialUnique, ...amapSpots, ...nominatimSpots]);
}

async function wikipediaSpots(city: any, limit = 40, requiredNames: string[] = [], preferences: string[] = [], env: any = null) {
  if (cleanText(env?.AMAP_WEB_KEY)) {
    const officialFirst = await fallbackCandidateSpots(city, requiredNames, preferences, env);
    if (officialFirst.length >= Math.max(12, requiredNames.length + 6)) {
      const neutralOfficial = officialFirst.map(spot => ({ ...spot, requiredByUser: false, category: spot.category === "用户必选" ? fallbackPoiCategory(spotSearchText(spot)) : spot.category }));
      return rankSpots(neutralOfficial, { style: preferences.join(" "), preferences }).slice(0, limit);
    }
  }
  const queries = [
    `${city.name} 旅游景点`,
    `${city.name} 公园 博物馆 古迹`,
    `${city.name} ${preferences.slice(0, 3).join(" ")}`.trim(),
    requiredNames.length ? `${city.name} ${requiredNames.join(" ")}` : `${city.name} 风景区 历史文化`,
  ];
  const common = {
    action: "query", prop: "coordinates|pageimages|extracts|pageprops", exintro: "1", explaintext: "1", exsentences: "3",
    piprop: "thumbnail", pithumbsize: "720", format: "json", formatversion: "2", redirects: "1",
  };
  const searchCalls = queries.map(query => {
    const params = new URLSearchParams({ ...common, generator: "search", gsrsearch: query, gsrnamespace: "0", gsrlimit: "40" });
    return fetchJson(`https://zh.wikipedia.org/w/api.php?${params}`, {}, 18000, "中文维基百科景点搜索");
  });
  const geoPoints = [[city.lat, city.lng], [city.lat + 0.08, city.lng - 0.08], [city.lat - 0.08, city.lng + 0.08]];
  const geoCalls = geoPoints.map(([lat, lng]) => {
    const params = new URLSearchParams({ ...common, generator: "geosearch", ggsprimary: "all", ggsnamespace: "0", ggsradius: "10000", ggslimit: "50", ggscoord: `${lat}|${lng}` });
    return fetchJson(`https://zh.wikipedia.org/w/api.php?${params}`, {}, 18000, "中文维基百科附近地点搜索");
  });
  const settled = await Promise.allSettled([...searchCalls, ...geoCalls]);
  const responses = settled.filter(result => result.status === "fulfilled").map((result: any) => result.value);
  if (!responses.length) {
    const fallback = await fallbackCandidateSpots(city, requiredNames, preferences, env);
    if (!fallback.length) throw new Error("中文维基、高德 POI 与 OSM/Nominatim 均未返回可核验景点，已停止规划以避免虚构数据");
    const neutralFallback = fallback.map(spot => ({ ...spot, requiredByUser: false, category: spot.category === "用户必选" ? fallbackPoiCategory(spotSearchText(spot)) : spot.category }));
    return rankSpots(neutralFallback, { style: preferences.join(" "), preferences }).slice(0, limit);
  }
  const pages = responses.flatMap(response => response?.query?.pages || []);
  const spots = uniqueSpots(pages.map(page => wikiPageToSpot(page, city, requiredNames, preferences)).filter(Boolean));
  // Wikipedia is useful for entity context but its search results often cluster around
  // one famous scenic area. Always merge a broad official-map pool so a multi-day plan
  // has geographically diverse, currently resolvable POIs instead of repeated sub-sites.
  const fallback = await fallbackCandidateSpots(city, requiredNames, preferences, env);
  const neutralCandidates = uniqueSpots([...fallback, ...spots]).map(spot => ({
    ...spot,
    requiredByUser: false,
    category: spot.category === "用户必选" ? fallbackPoiCategory(spotSearchText(spot)) : spot.category,
  }));
  return rankSpots(neutralCandidates, { style: preferences.join(" "), preferences }).slice(0, limit);
}

async function verifyRequired(city: any, names: string[], candidates: any[] = [], env: any = null) {
  const verified: any[] = [];
  for (const name of names) {
    const minimumEntityScore = normalizeName(name).length <= 3 ? 100 : 85;
    const localMatch = candidates
      .map(item => ({ item, score: poiMatchScore(item.name, [name, `${city.name}${name}`]) }))
      .filter(entry => entry.score >= minimumEntityScore)
      .sort((left, right) => right.score - left.score || haversine(city.lat, city.lng, left.item.lat, left.item.lng) - haversine(city.lat, city.lng, right.item.lat, right.item.lng))[0]?.item;
    if (localMatch) {
      verified.push({ ...localMatch, name, officialName: localMatch.name, requiredByUser: true, category: "用户必选", recommendationReasons: ["用户明确指定的必选项", "已在本次公开地图候选景点中完成实体消歧"] });
      continue;
    }
    const officialKey = cleanText(env?.AMAP_WEB_KEY);
    if (officialKey) {
      try {
        const amapParams = new URLSearchParams({ key: officialKey, keywords: name, city: city.name, citylimit: "true", extensions: "all", offset: "10", page: "1" });
        const amapRaw = await fetchJson(`https://restapi.amap.com/v3/place/text?${amapParams}`, {}, 15000, `必选景点“${name}”高德官方核验`);
        const exact = (amapRaw?.pois || []).map((row: any) => ({ row, score: poiMatchScore(row?.name, [name, `${city.name}${name}`]) })).filter((item: any) => item.score >= minimumEntityScore).sort((a: any, b: any) => b.score - a.score)[0]?.row;
        const amapSpot = exact ? amapCandidateRecord(exact, city, [name]) : null;
        if (amapSpot) {
          verified.push({ ...amapSpot, name, officialName: amapSpot.name, requiredByUser: true, category: "用户必选", recommendationReasons: ["用户明确指定的必选项", "已通过高德官方 Web POI 精确核验"] });
          continue;
        }
      } catch { /* 继续使用共享 MCP 与 OSM 兜底 */ }
    }
    try {
      const mcpRows = amapPoiRows(await callMcp(AMAP_MCP, "maps_text_search", { keywords: name, city: city.name, types: "风景名胜" }, { timeoutMs: 10000, cacheMs: 30 * 60 * 1000 }));
      const exact = mcpRows.map((row: any) => ({ row, score: poiMatchScore(row?.name, [name, `${city.name}${name}`]) })).filter((item: any) => item.score >= minimumEntityScore).sort((a: any, b: any) => b.score - a.score)[0]?.row;
      const amapSpot = exact ? amapCandidateRecord(exact, city, [name]) : null;
      if (amapSpot) {
        verified.push({ ...amapSpot, name, officialName: amapSpot.name, requiredByUser: true, category: "用户必选", recommendationReasons: ["用户明确指定的必选项", "已通过高德地图 MCP 精确核验"] });
        continue;
      }
    } catch { /* 继续使用 OSM 兜底 */ }
    const params = new URLSearchParams({ q: `${name}, ${city.name}, 中国`, format: "jsonv2", addressdetails: "1", extratags: "1", namedetails: "1", limit: "5", countrycodes: "cn", "accept-language": "zh-CN" });
    let rows: any[] = [];
    try { rows = await fetchJson(`${NOMINATIM}/search?${params}`, {}, 18000, `必选景点“${name}”地图核验`); } catch { rows = []; }
    const best = (rows || []).find((row: any) => normalizeName(row.name || row.display_name.split(",")[0]).includes(normalizeName(name))) || rows?.[0];
    if (!best) throw new Error(`必选景点“${name}”未能通过高德官方、高德 MCP 或 OSM 地图数据核验，已停止规划以避免遗漏或臆造`);
    const lat = Number(best.lat), lng = Number(best.lon);
    const distance = haversine(city.lat, city.lng, lat, lng);
    if (distance > 80000) throw new Error(`必选景点“${name}”与目的地距离异常，已停止规划等待核验`);
    verified.push({
      id: `nominatim-${best.osm_type}-${best.osm_id}`, name, officialName: cleanText(best.name || name), lat, lng,
      category: "用户必选", durationMin: 120, openingHours: "", website: cleanText(best.extratags?.website),
      wikipedia: cleanText(best.extratags?.wikipedia), wikidata: cleanText(best.extratags?.wikidata),
      staticPoiQuality: "已核验", sourceUrl: `https://www.openstreetmap.org/${best.osm_type}/${best.osm_id}`,
      fetchedAt: new Date().toISOString(), requiredByUser: true,
      crowd: { score: null, label: "未知", source: "未接入可验证官方客流" },
      openingStatus: { status: "unknown", label: "开放时间未知，出发前请复核" },
      recommendationReasons: ["用户明确指定的必选项", "已通过 Nominatim/OSM 地点核验"], transitStops: [],
    });
  }
  return verified;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PREFERENCE_TERMS: Record<string, string[]> = {
  "自然": ["自然", "山", "湖", "江", "海", "湿地", "森林", "公园", "植物", "风景"],
  "摄影": ["自然", "山", "湖", "江", "海", "古镇", "建筑", "夜景", "观景", "风景"],
  "人文": ["文化", "历史", "博物", "古城", "古镇", "遗址", "寺", "故居", "建筑"],
  "文化": ["文化", "历史", "博物", "非遗", "遗址", "寺", "古建"],
  "亲子": ["动物", "植物", "科技", "海洋", "乐园", "公园", "博物"],
  "夜景": ["夜景", "广场", "滨水", "步行街", "古城", "塔", "地标"],
};

function spotSearchText(spot: any) {
  return `${cleanText(spot.name)} ${cleanText(spot.category)} ${cleanText(spot.extract)} ${cleanText(spot.address)}`;
}

function scoreSpot(spot: any, profile: any) {
  const text = spotSearchText(spot);
  const preferences = [...new Set([profile.style, ...profile.preferences].filter(Boolean))];
  const matched = preferences.filter((preference: string) => {
    const terms = PREFERENCE_TERMS[preference] || [preference];
    return terms.some(term => text.includes(term));
  });
  const preference = preferences.length ? Math.round(45 + 55 * matched.length / preferences.length) : 60;
  const rating = Number(spot.rating || 0);
  const quality = rating >= 4.5 ? 96 : rating >= 4 ? 88 : rating >= 3.5 ? 76 : spot.staticPoiQuality === "较高" ? 88 : spot.staticPoiQuality === "一般" ? 68 : 58;
  const completeness = Math.min(100, 45 + (spot.sourceUrl ? 15 : 0) + (spot.lat && spot.lng ? 20 : 0) + (spot.extract ? 12 : 0) + (spot.openingHours ? 8 : 0));
  const season = spot.seasonality?.score == null ? 50 : Number(spot.seasonality.score);
  const crowdProbability = spot.crowd?.score == null ? 50 : Number(spot.crowd.score);
  const avoidCrowd = profile.crowdSensitivity === "high" || (profile.avoid || []).some((item: string) => /拥挤|人流/.test(item));
  const crowdFit = avoidCrowd ? 100 - crowdProbability : 55;
  const required = Boolean(spot.requiredByUser);
  const final = required ? 100 : Math.round(preference * 0.42 + quality * 0.2 + completeness * 0.16 + season * 0.12 + crowdFit * 0.1);
  return {
    final, required, matched,
    breakdown: { preference, poiQuality: quality, dataCompleteness: completeness, seasonality: season, crowdFit },
    basis: "偏好 42% · POI 质量 20% · 数据完整度 16% · 时令证据 12% · 拥挤适配 10%",
  };
}

function rankSpots(spots: any[], profile: any) {
  return [...spots]
    .map(spot => {
      const score = scoreSpot(spot, profile);
      const recommendationReasons = [...(spot.recommendationReasons || [])];
      if (score.required) recommendationReasons.unshift("用户明确指定的必选项");
      else if (score.matched.length) recommendationReasons.unshift(`匹配偏好：${score.matched.join(" / ")}`);
      recommendationReasons.push(`本地可解释评分 ${score.final} 分`);
      return { ...spot, plannerScore: score.final, scoreBreakdown: score.breakdown, scoreBasis: score.basis, matchedPreferences: score.matched, recommendationReasons: [...new Set(recommendationReasons)].slice(0, 4) };
    })
    .sort((a, b) => Number(b.requiredByUser) - Number(a.requiredByUser)
      || b.plannerScore - a.plannerScore
      || Number(b.rating || 0) - Number(a.rating || 0)
      || Number(a.providerRank ?? Number.MAX_SAFE_INTEGER) - Number(b.providerRank ?? Number.MAX_SAFE_INTEGER)
      || a.name.localeCompare(b.name, "zh-CN"));
}

function officialDomain(value: unknown) {
  const domain = cleanText(value).toLowerCase();
  return domain.endsWith(".gov.cn") || domain === "gov.cn" || /(?:^|\.)mct\.gov\.cn$/.test(domain);
}

function articleDate(value: unknown) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00"] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function articleMatchesSpot(article: any, spot: any) {
  const title = normalizeName(article?.title);
  if (!title) return false;
  return imageLookupNames(spot.name).some((alias) => {
    const wanted = normalizeName(alias);
    return wanted.length >= 2 && title.includes(wanted);
  });
}

function decodeXmlText(value: unknown) {
  return cleanText(value)
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function rssTag(item: string, tag: string) {
  return decodeXmlText(item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "");
}

async function bingNewsTravelSignals(city: any, spots: any[]) {
  const targets = spots.slice(0, 8);
  const cacheKey = `bing-news:${city.name}:${targets.map((spot) => spot.name).join("|")}`;
  const cached = intelligenceMemory.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const settled = await Promise.allSettled(targets.map(async (spot) => {
      const params = new URLSearchParams({ q: `${city.name} ${spot.name}`, format: "RSS" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${BING_NEWS_RSS}?${params}`, fetchOptions({ signal: controller.signal, headers: { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" } })).finally(() => clearTimeout(timer));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await response.text();
      if (!/^\s*<\?xml/i.test(xml)) throw new Error("未返回 RSS XML");
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const articles = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 30).map((match) => {
        const item = match[1];
        const rssUrl = rssTag(item, "link");
        let url = rssUrl;
        try { url = new URL(rssUrl).searchParams.get("url") || rssUrl; } catch { /* 保留 RSS 链接 */ }
        let domain = "";
        try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* 无法解析的来源保持空值 */ }
        const published = Date.parse(rssTag(item, "pubDate"));
        return { title: rssTag(item, "title"), url, domain, sourceUrl: url, seenAt: Number.isFinite(published) ? new Date(published).toISOString() : null, language: "Chinese", sourceCountry: "China" };
      }).filter((article) => article.title && article.url && article.seenAt && Date.parse(article.seenAt) >= cutoff && articleMatchesSpot(article, spot));
      return { spot, articles };
    }));
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled");
    if (!fulfilled.length) throw new Error(settled.map((result: any) => result.reason?.message).filter(Boolean).join("；") || "新闻 RSS 未返回");
    const allArticles = fulfilled.flatMap((result) => result.value.articles);
    const articles = [...new Map(allArticles.map((article) => [article.url || article.title, article])).values()];
    const bySpot = new Map<string, any>();
    for (const spot of spots) {
      const matches = articles.filter((article) => articleMatchesSpot(article, spot));
      const seasonal = matches.filter((article) => /花期|赏花|樱花|荷花|桂花|梅花|杜鹃|红叶|秋色|银杏|雪景|冰雪|观鸟|候鸟|花海|枫叶/.test(article.title));
      const openingAlerts = matches.filter((article) => officialDomain(article.domain) && /闭园|暂停开放|临时关闭|恢复开放|预约|限流|停止入园|开放时间|停止售票/.test(article.title));
      bySpot.set(spot.id, { mentions: matches.length, domains: new Set(matches.map((article) => article.domain)).size, articles: matches.slice(0, 4), seasonal: seasonal.slice(0, 3), openingAlerts: openingAlerts.slice(0, 3) });
    }
    const value = { status: "ready", provider: "Bing 新闻 RSS · 近 7 天中文公开报道", articles, bySpot, fetchedAt: new Date().toISOString() };
    intelligenceMemory.set(cacheKey, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch (error: any) {
    return { status: "unavailable", provider: "Bing 新闻 RSS", articles: [], bySpot: new Map(), error: cleanText(error?.message, "中文公开报道服务不可用"), fetchedAt: new Date().toISOString() };
  }
}

async function gdeltTravelSignals(city: any, spots: any[]) {
  const names = [...new Set(spots.map((spot) => cleanText(spot.name)).filter(Boolean))].slice(0, 12);
  if (!names.length) return { status: "unavailable", provider: "GDELT DOC 2.0", articles: [], bySpot: new Map(), error: "没有可查询景点" };
  const cacheKey = `gdelt:${city.name}:${names.join("|")}`;
  const cached = intelligenceMemory.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const params = new URLSearchParams({
      query: `${city.name}旅游`,
      mode: "artlist", format: "json", maxrecords: "100", timespan: "1week", sort: "datedesc",
    });
    const raw = await fetchJson(`${GDELT_DOC}?${params}`, {}, 5000, "GDELT 公开新闻趋势");
    const articles = (Array.isArray(raw?.articles) ? raw.articles : []).map((article: any) => ({
      title: cleanText(article.title), url: cleanText(article.url), domain: cleanText(article.domain),
      seenAt: articleDate(article.seendate), language: cleanText(article.language), sourceCountry: cleanText(article.sourcecountry),
    })).filter((article: any) => article.title && article.url);
    const bySpot = new Map<string, any>();
    for (const spot of spots) {
      const matches = articles.filter((article: any) => articleMatchesSpot(article, spot));
      const seasonal = matches.filter((article: any) => /花期|赏花|樱花|荷花|桂花|梅花|杜鹃|红叶|秋色|银杏|雪景|冰雪|观鸟|候鸟|花海|枫叶/.test(article.title));
      const openingAlerts = matches.filter((article: any) => officialDomain(article.domain) && /闭园|暂停开放|临时关闭|恢复开放|预约|限流|停止入园|开放时间|停止售票/.test(article.title));
      bySpot.set(spot.id, {
        mentions: matches.length,
        domains: new Set(matches.map((article: any) => article.domain)).size,
        articles: matches.slice(0, 4), seasonal: seasonal.slice(0, 3), openingAlerts: openingAlerts.slice(0, 3),
      });
    }
    const value = { status: "ready", provider: "GDELT DOC 2.0 公开新闻趋势", articles, bySpot, fetchedAt: new Date().toISOString() };
    intelligenceMemory.set(cacheKey, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch (error: any) {
    const value = { status: "unavailable", provider: "GDELT DOC 2.0", articles: [], bySpot: new Map(), error: cleanText(error?.message, "公开趋势服务不可用"), fetchedAt: new Date().toISOString() };
    intelligenceMemory.set(cacheKey, { value, expiresAt: Date.now() + 10 * 60 * 1000 });
    return value;
  }
}

async function publicTravelSignals(city: any, spots: any[]) {
  const chineseNews = await bingNewsTravelSignals(city, spots);
  if (chineseNews.status === "ready") return chineseNews;
  const gdelt = await gdeltTravelSignals(city, spots);
  return { ...gdelt, fallbackError: chineseNews.error || (chineseNews.status === "ready" ? "中文新闻 RSS 未返回条目" : "中文新闻 RSS 不可用") };
}

async function domesticHotSignals(env: any, city: any, spots: any[]) {
  const base = cleanText(env?.NEWSNOW_BASE_URL).replace(/\/$/, "");
  const cacheKey = `domestic-hot:${base || "direct"}`;
  const cached = intelligenceMemory.get(cacheKey);
  let cachedValue = cached && cached.expiresAt > Date.now() ? cached.value : null;
  if (!cachedValue) {
    const requests: Record<string, Promise<any>> = {
      baidu: fetchJson("https://top.baidu.com/api/board?platform=wise&tab=realtime", {}, 9000, "百度实时热搜"),
      toutiao: fetchJson("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", {}, 9000, "今日头条热榜"),
      bilibili: fetchJson("https://api.bilibili.com/x/web-interface/search/square?limit=50", {}, 9000, "哔哩哔哩热搜"),
    };
    if (base) {
      for (const id of NEWSNOW_SOURCES) requests[`newsnow-${id}`] = fetchJson(`${base}/api/s?id=${encodeURIComponent(id)}`, {}, 9000, `NewsNow ${id}`);
    }
    const providers = await settleTravelProviders(requests);
    const fetchedAt = new Date().toISOString();
    const entries: any[] = [];
    if (providers.baidu?.status === "ready") {
      const cards = Array.isArray((providers.baidu.data as any)?.data?.cards) ? (providers.baidu.data as any).data.cards : [];
      const rows = cards.flatMap((card: any) => (Array.isArray(card?.content) ? card.content : [])).flatMap((group: any) => Array.isArray(group?.content) ? group.content : [group]);
      rows.filter((row: any) => !row?.isTop && row?.word).forEach((row: any, index: number) => entries.push({ title: cleanText(row.word), url: cleanText(row.url || row.rawUrl), source: "百度热搜", rank: Number(row.index || index + 1), updatedAt: fetchedAt }));
    }
    if (providers.toutiao?.status === "ready") {
      const rows = Array.isArray((providers.toutiao.data as any)?.data) ? (providers.toutiao.data as any).data : [];
      rows.forEach((row: any, index: number) => entries.push({ title: cleanText(row.Title), url: row.ClusterIdStr ? `https://www.toutiao.com/trending/${encodeURIComponent(row.ClusterIdStr)}/` : "", source: "今日头条热榜", rank: index + 1, updatedAt: fetchedAt }));
    }
    if (providers.bilibili?.status === "ready") {
      const rows = Array.isArray((providers.bilibili.data as any)?.data?.trending?.list) ? (providers.bilibili.data as any).data.trending.list : [];
      rows.forEach((row: any, index: number) => entries.push({ title: cleanText(row.show_name || row.keyword), url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(cleanText(row.keyword || row.show_name))}`, source: "哔哩哔哩热搜", rank: index + 1, updatedAt: fetchedAt }));
    }
    for (const id of NEWSNOW_SOURCES) {
      const payload = providers[`newsnow-${id}`]?.status === "ready" ? providers[`newsnow-${id}`].data as any : null;
      (Array.isArray(payload?.items) ? payload.items : []).forEach((item: any, index: number) => entries.push({ title: cleanText(item.title), url: cleanText(item.url), source: `NewsNow ${id}`, rank: index + 1, updatedAt: Number.isFinite(Number(payload.updatedTime)) ? new Date(Number(payload.updatedTime)).toISOString() : fetchedAt }));
    }
    const readyProviders = Object.entries(providers).filter(([, result]: any) => result.status === "ready").map(([name]) => name);
    cachedValue = { entries: entries.filter((item) => item.title), readyProviders, fetchedAt };
    if (cachedValue.entries.length) intelligenceMemory.set(cacheKey, { value: cachedValue, expiresAt: Date.now() + 10 * 60 * 1000 });
  }
  const entries = cachedValue?.entries || [];
  if (!entries.length) return { status: "unavailable", provider: "国内公开热榜", bySpot: new Map(), detail: "百度、头条、哔哩哔哩及可选 NewsNow 均未返回" };
  const bySpot = new Map<string, number>();
  for (const spot of spots) {
    const wanted = imageLookupNames(spot.name, city.name).map(normalizeName).filter(Boolean);
    const matches = entries.filter((entry) => wanted.some((name) => normalizeName(entry.title).includes(name)));
    bySpot.set(spot.id, matches.reduce((score, entry) => score + (entry.rank <= 10 ? 2 : 1), 0));
  }
  return {
    status: "ready", provider: `国内公开热榜（${cachedValue.readyProviders.join(" / ")}）`, bySpot,
    fetchedAt: cachedValue.fetchedAt,
    detail: `${cachedValue.readyProviders.length} 个国内热榜来源返回；只统计标题中可归因到景点的提及`,
  };
}

async function optionalSocialSignals(env: any, city: any, spots: any[]) {
  const publicSignals = await domesticHotSignals(env, city, spots);
  const endpoint = cleanText(env?.SOCIAL_MCP_URL);
  if (!endpoint) return publicSignals;
  const tool = cleanText(env?.SOCIAL_MCP_TOOL, "search_feeds");
  const platform = cleanText(env?.SOCIAL_MCP_PLATFORM, "authorized-social-mcp");
  try {
    const raw = await callMcp(endpoint, tool, { keyword: `${city.name} 旅游景点`, query: `${city.name} 旅游景点` }, { timeoutMs: 12000, cacheMs: 20 * 60 * 1000 });
    const haystack = normalizeName(JSON.stringify(raw));
    const bySpot = new Map<string, number>();
    for (const spot of spots) {
      const wanted = normalizeName(spot.name);
      bySpot.set(spot.id, Number(publicSignals.bySpot.get(spot.id) || 0) + (wanted ? Math.max(0, haystack.split(wanted).length - 1) : 0));
    }
    return { status: "ready", provider: `${publicSignals.status === "ready" ? `${publicSignals.provider} + ` : ""}${platform} MCP（授权实例）`, bySpot, fetchedAt: new Date().toISOString(), detail: `${publicSignals.detail || ""}；${tool} 已返回授权数据` };
  } catch (error: any) {
    return { ...publicSignals, detail: `${publicSignals.detail || ""}；可选 ${platform} MCP 未返回：${cleanText(error?.message, "不可用")}` };
  }
}

function visitSemantics(spot: any, weatherDays: any[] = []) {
  const text = `${cleanText(spot?.name)} ${cleanText(spot?.officialName)} ${cleanText(spot?.category)} ${cleanText(spot?.type)}`;
  const firstSunset = weatherDays.map((day: any) => cleanText(day?.sunset)).find(Boolean) || "18:30";
  if (/饭店|餐厅|酒楼|餐馆|食府|茶楼|小吃/.test(text)) return { role: "meal-landmark", preferredWindows: ["11:30-13:30", "17:30-20:00"], avoidWindows: ["09:00-11:00", "14:00-17:00"], rationale: "餐饮型目的地应进入午餐或晚餐时段，不能当普通上午景点安排" };
  if (/外滩|夜景|夜游|灯光秀|天际线|观景台|电视塔/.test(text)) return { role: "nightscape", preferredWindows: [`${firstSunset}-21:00`], avoidWindows: ["09:00-16:30"], rationale: `夜景型地点应在日落（约 ${firstSunset}）后安排，同时保留返程时间` };
  if (/博物馆|美术馆|纪念馆|展览馆|科技馆/.test(text)) return { role: "timed-indoor", preferredWindows: ["09:30-11:30", "13:30-16:30"], avoidWindows: ["12:00-13:00"], rationale: "展馆优先服从开放与预约时段" };
  if (/公园|园|湖|山|湿地|古镇|寺|庙/.test(text)) return { role: "daylight-outdoor", preferredWindows: ["08:30-11:00", `15:30-${firstSunset}`], avoidWindows: ["11:30-14:30"], rationale: "户外与摄影地点优先柔和光线和较低体感时段" };
  return { role: "flexible", preferredWindows: ["09:30-11:30", "14:00-17:00"], avoidWindows: [], rationale: "在开放时间、交通矩阵和用餐缓冲内灵活安排" };
}

function officialVerificationFor(spot: any, cityName: string) {
  let officialSiteUrl: string | null = null;
  try {
    const candidate = new URL(cleanText(spot?.website));
    if (candidate.protocol === "https:" && !/amap\.com|wikipedia\.org|openstreetmap\.org/.test(candidate.hostname)) officialSiteUrl = candidate.href;
  } catch { officialSiteUrl = null; }
  const baseQuery = `${cityName} ${cleanText(spot?.name)} 官方`;
  return {
    officialSiteUrl,
    openingSearchUrl: `https://www.baidu.com/s?wd=${encodeURIComponent(`${baseQuery} 开放 公告`)}`,
    reservationSearchUrl: `https://www.baidu.com/s?wd=${encodeURIComponent(`${baseQuery} 预约 门票`)}`,
    openingNature: officialSiteUrl && spot?.openingStatus?.status === "verified" ? "official" : spot?.openingHours ? "map-rule" : "unknown",
    reservationAvailability: "unknown",
    note: "没有全国统一预约余量接口；链接用于查找景区官方公告或预约入口，不能证明指定日期仍有名额。",
  };
}

async function enrichTravelIntelligence(spots: any[], profile: any, city: any, weather: any, env: any) {
  const targets = spots.slice(0, 16);
  const [news, social, amapResults] = await Promise.all([
    publicTravelSignals(city, targets),
    optionalSocialSignals(env, city, targets),
    Promise.allSettled(targets.slice(0, 12).map((spot) => amapPoiForSpot(spot.name, city.name))),
  ]);
  const amapById = new Map<string, any>();
  targets.slice(0, 12).forEach((spot, index) => {
    const result = amapResults[index];
    if (result?.status === "fulfilled" && result.value) amapById.set(spot.id, result.value);
  });
  const fetchedAt = new Date().toISOString();
  const enriched = spots.map((spot) => {
    const signal = news.bySpot.get(spot.id) || { mentions: 0, domains: 0, articles: [], seasonal: [], openingAlerts: [] };
    const socialMentions = Number(social.bySpot.get(spot.id) || 0);
    const amap = amapById.get(spot.id);
    const raw = amap?.raw || {};
    const amapOpening = cleanText(raw?.business?.opentime_today || raw?.business?.opentime_week || raw?.opentime_today || raw?.opentime_week || raw?.opening_hours);
    const openingHours = amapOpening || spot.openingHours || "";
    const ratingValue = Number(raw?.biz_ext?.rating || raw?.business?.rating || raw?.rating);
    const rating = Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : null;
    const mentionCount = Number(signal.mentions || 0) + socialMentions;
    const hotness = mentionCount > 0 ? {
      score: clamp(32 + mentionCount * 10 + Number(signal.domains || 0) * 6 + Math.min(12, socialMentions * 3), 35, 95),
      label: mentionCount >= 4 || Number(signal.domains || 0) >= 3 ? "近期关注较高" : "近期有公开提及",
      status: "predicted", confidence: Math.min(0.8, 0.45 + Number(signal.domains || 0) * 0.05 + (socialMentions > 0 ? 0.1 : 0)),
      updatedAt: news.fetchedAt || social.fetchedAt || fetchedAt,
      source: [signal.mentions ? news.provider : "", socialMentions ? social.provider : ""].filter(Boolean).join(" + "),
      sourceUrl: signal.articles?.[0]?.url || null,
    } : { score: null, label: "近 7 天未取得可归因趋势信号", status: "unknown", confidence: 0, updatedAt: news.fetchedAt || fetchedAt, source: news.provider, sourceUrl: null };
    const seasonalArticle = signal.seasonal?.[0];
    const daysToTrip = Math.round((new Date(`${profile.startDate}T12:00:00+08:00`).getTime() - Date.now()) / 86_400_000);
    const articleAgeDays = seasonalArticle?.seenAt ? Math.max(0, Math.round((Date.now() - Date.parse(seasonalArticle.seenAt)) / 86_400_000)) : 7;
    const seasonSignalUsable = Boolean(seasonalArticle && daysToTrip >= 0 && daysToTrip <= 30);
    const seasonScore = seasonSignalUsable ? clamp(76 - articleAgeDays * 3 - Math.max(0, daysToTrip - 14), 42, 82) : null;
    const seasonality = seasonSignalUsable ? {
      score: seasonScore, state: daysToTrip <= 14 ? "RECENT_SIGNAL" : "FORWARD_REFERENCE", label: `近 ${articleAgeDays || 1} 天公开报道信号：${cleanText(seasonalArticle.title).slice(0, 36)}`, status: "predicted", confidence: Math.max(0.42, Math.min(0.7, 0.68 - articleAgeDays * 0.025 - Math.max(0, daysToTrip - 14) * 0.008)),
      updatedAt: seasonalArticle.seenAt || news.fetchedAt || fetchedAt, source: `近期公开报道 · ${seasonalArticle.domain}`, sourceUrl: seasonalArticle.url,
    } : { score: null, state: "UNKNOWN", label: seasonalArticle && daysToTrip > 30 ? "出行日期距当前较远，近期报道不能代表到访日物候" : "未取得可用于到访日期的近期时令报道信号", status: "unknown", confidence: 0, updatedAt: news.fetchedAt || fetchedAt, source: news.provider, sourceUrl: seasonalArticle?.url || null };
    const crowd = predictCrowdRisk({
      date: profile.startDate,
      spot,
      weather: weather?.tripForecast?.[0],
      hotness,
      rating,
      socialMentions,
      updatedAt: fetchedAt,
    });
    const crowdSourceUrl = hotness.sourceUrl || spot.sourceUrl || null;
    const openingAlert = signal.openingAlerts?.[0];
    const factObservations = { ...(spot.factObservations || {}) };
    if (openingHours) factObservations.openingHours = [{ value: openingHours, confidence: amapOpening ? 0.78 : 0.68, source: { id: `source-${spot.id}-opening-amap`, name: amapOpening ? "高德地图 POI 营业时间" : cleanText(spot.sourceName, "公开 POI 页面"), type: "map-service", url: amap?.id ? `https://www.amap.com/place/${encodeURIComponent(amap.id)}` : spot.sourceUrl || null, fetchedAt, quality: "estimated" } }];
    factObservations.crowd = [{ value: { score: crowd.score, label: crowd.label, probability: crowd.riskProbability, factors: crowd.factors, factorContributions: crowd.factorContributions, forecastBand: crowd.forecastBand, confidenceLabel: crowd.confidenceLabel, evidenceCoverage: crowd.evidenceCoverage, recommendedWindow: crowd.recommendedWindow, recommendedWindows: crowd.recommendedWindows, avoidWindow: crowd.avoidWindow, peakWindow: crowd.peakWindow, modelVersion: crowd.modelVersion, officialRealtime: false }, confidence: crowd.confidence, source: { id: `source-${spot.id}-crowd-model`, name: "Crowd Risk v2 多源风险模型", type: "prediction", url: crowdSourceUrl, fetchedAt, quality: "predicted" } }];
    if (hotness.score != null) factObservations.hotness = [{ value: { score: hotness.score, label: hotness.label }, confidence: hotness.confidence, source: { id: `source-${spot.id}-hotness`, name: hotness.source, type: "public-trend", url: hotness.sourceUrl, fetchedAt: hotness.updatedAt, quality: "predicted" } }];
    if (seasonality.score != null) factObservations.seasonality = [{ value: { score: seasonality.score, state: seasonality.state, label: seasonality.label }, confidence: seasonality.confidence, source: { id: `source-${spot.id}-seasonality`, name: seasonality.source, type: "public-season-signal", url: seasonality.sourceUrl, fetchedAt: seasonality.updatedAt, quality: "predicted" } }];
    return {
      ...spot, openingHours, rating, hotness, seasonality,
      openingStatus: { status: openingAlert ? "conflicting" : openingHours ? "estimated" : "unknown", label: openingHours ? `地图营业时间：${openingHours}` : "开放时间暂未核验", alert: openingAlert ? `检测到官方来源相关公告：${openingAlert.title}` : null, sourceUrl: openingAlert?.url || null, updatedAt: fetchedAt },
      crowd: { ...crowd, source: "日期/时段 + 景点承载特征 + 天气 + 公开趋势；非实时人数", updatedAt: fetchedAt },
      factObservations,
    };
  });
  return { spots: enriched, news, social, fetchedAt };
}

export function uniqueSpots(spots: any[]) {
  const result: any[] = [];
  for (const spot of spots) {
    const key = normalizeName(spot?.name);
    if (!key) continue;
    const parentName = cleanText(spot.name).split(/[·•—－\-（(]/)[0];
    const aliases = [...new Set([spot.name, spot.officialName, parentName, ...(Array.isArray(spot.aliases) ? spot.aliases : [])].map((value) => cleanText(value)).filter(Boolean))];
    const duplicateIndex = result.findIndex((existing) => {
      const existingKeys = [existing.name, existing.officialName, ...(existing.aliases || [])].map(normalizeName).filter(Boolean);
      const sameAlias = existingKeys.includes(key) || aliases.map(normalizeName).some((alias) => existingKeys.includes(alias));
      const coordinatesClose = Number.isFinite(Number(existing.lat)) && Number.isFinite(Number(existing.lng))
        && Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lng))
        && haversine(existing.lat, existing.lng, spot.lat, spot.lng) <= 70;
      const relatedName = existingKeys.some((existingKey) => existingKey.includes(key) || key.includes(existingKey));
      return sameAlias || (coordinatesClose && relatedName);
    });
    const enriched = { ...spot, aliases, parentName: parentName !== spot.name ? parentName : null };
    if (duplicateIndex < 0) {
      result.push(enriched);
      continue;
    }
    const existing = result[duplicateIndex];
    const preferred = enriched.requiredByUser && !existing.requiredByUser ? enriched : existing;
    const secondary = preferred === enriched ? existing : enriched;
    result[duplicateIndex] = {
      ...secondary,
      ...preferred,
      aliases: [...new Set([...(existing.aliases || []), ...aliases])],
      factObservations: { ...(secondary.factObservations || {}), ...(preferred.factObservations || {}) },
      sourceAlternatives: [...new Set([...(existing.sourceAlternatives || []), existing.sourceUrl, spot.sourceUrl].filter(Boolean))],
    };
  }
  return result;
}

function amapPoiRows(value: any) {
  const data = mcpData(value) || value || {};
  return Array.isArray(data) ? data : data.pois || data.suggestion?.pois || [];
}

async function amapPoiForSpot(name: string, city: string) {
  const lookupNames = imageLookupNames(name, city);
  const searched: any = await callMcp(AMAP_MCP, "maps_text_search", { keywords: lookupNames[0], city, types: "风景名胜" }, { timeoutMs: 9000, cacheMs: 30 * 60 * 1000 });
  const rows = amapPoiRows(searched);
  const poi = [...rows].sort((a: any, b: any) => poiImageScore(b, lookupNames) - poiImageScore(a, lookupNames))[0];
  if (!poi || !poiImageScore(poi, lookupNames)) return null;
  let detail: any = poi;
  if (poi.id) {
    try { detail = mcpData(await callMcp(AMAP_MCP, "maps_search_detail", { id: cleanText(poi.id) }, { timeoutMs: 9000, cacheMs: 60 * 60 * 1000 })) || poi; } catch { detail = poi; }
  }
  if (Array.isArray(detail?.pois)) detail = detail.pois[0] || poi;
  const photos = [...(Array.isArray(poi.photos) ? poi.photos : []), ...(Array.isArray(detail?.photos) ? detail.photos : [])];
  const photo = photos.map((item: any) => secureImageUrl(typeof item === "string" ? item : item?.url || item?.photo_url)).find(Boolean);
  const location = cleanText(detail?.location || poi.location);
  return { id: cleanText(poi.id), name: cleanText(poi.name), location, photo, raw: detail };
}

async function amapOfficialImage(env: any, name: string, city: string, poiId = "", targetLat?: number, targetLng?: number) {
  const key = cleanText(env?.AMAP_WEB_KEY);
  if (!key || !name) return null;
  const lookupNames = imageLookupNames(name, city);
  const exactId = cleanText(poiId).replace(/^amap-/, "");
  if (exactId && !/^-?\d+(?:\.\d+)?--?\d/.test(exactId)) {
    try {
      const detailParams = new URLSearchParams({ key, id: exactId, extensions: "all" });
      const detailRaw = await fetchJson(`https://restapi.amap.com/v3/place/detail?${detailParams}`, {}, 15000, "高德地图官方 POI 详情");
      const poi = detailRaw?.pois?.[0];
      const photo = (poi?.photos || []).map((item: any) => secureImageUrl(item?.url)).find(Boolean);
      const [lng, lat] = cleanText(poi?.location).split(",").map(Number);
      const distanceM = Number.isFinite(targetLat) && Number.isFinite(targetLng) && Number.isFinite(lat) && Number.isFinite(lng) ? haversine(targetLat, targetLng, lat, lng) : 0;
      if (photo && (!distanceM || distanceM <= 1200)) return { found: true, url: photo, source: "高德地图官方 POI ID 精确照片", provider: "amap-official", sourceUrl: `https://www.amap.com/place/${encodeURIComponent(exactId)}`, verifiedName: cleanText(poi?.name, name), matchQuality: "amap-official-poi-id", distanceM: Math.round(distanceM) };
    } catch { /* 精确 ID 不可用时继续名称和坐标回退 */ }
  }
  for (const lookupName of lookupNames) {
    const params = new URLSearchParams({ key, keywords: lookupName, city, citylimit: "true", extensions: "all", offset: "20", page: "1" });
    const raw = await fetchJson(`https://restapi.amap.com/v3/place/text?${params}`, {}, 15000, "高德地图官方 Web 服务");
    if (String(raw?.status) !== "1") throw new Error(cleanText(raw?.info, "高德地图官方接口未返回成功状态"));
    const ranked = [...(raw?.pois || [])]
      .map((poi: any) => {
        const [lng, lat] = cleanText(poi?.location).split(",").map(Number);
        const distanceM = Number.isFinite(targetLat) && Number.isFinite(targetLng) && Number.isFinite(lat) && Number.isFinite(lng) ? haversine(targetLat, targetLng, lat, lng) : 0;
        return { poi, distanceM, score: poiImageScore(poi, lookupNames) - (distanceM ? Math.min(50, distanceM / 120) : 0), photo: (poi?.photos || []).map((item: any) => secureImageUrl(item?.url)).find(Boolean) };
      })
      .filter((item: any) => item.score > 0 && item.photo && (!item.distanceM || item.distanceM <= 1200))
      .sort((a: any, b: any) => b.score - a.score);
    const best = ranked[0];
    if (!best) continue;
    const id = cleanText(best.poi.id);
    return {
      found: true, url: best.photo, source: "高德地图官方 POI 精确照片", provider: "amap-official",
      sourceUrl: id ? `https://www.amap.com/place/${encodeURIComponent(id)}` : "https://www.amap.com/",
      verifiedName: cleanText(best.poi.name, name), matchQuality: poiMatchScore(best.poi.name, lookupNames) === 100 ? "amap-official-exact-poi" : "amap-official-related-poi", distanceM: Math.round(best.distanceM || 0),
    };
  }
  return null;
}

function withUnsplashUtm(value: unknown) {
  const url = cleanText(value, "https://unsplash.com/");
  return `${url}${url.includes("?") ? "&" : "?"}utm_source=smart_travel_assistant&utm_medium=referral`;
}

async function unsplashImage(env: any, name: string, city: string, englishName = "") {
  const accessKey = cleanText(env?.UNSPLASH_ACCESS_KEY);
  if (!accessKey || !name) return null;
  const queries = [...new Set([
    englishName ? `${englishName} ${city} China` : "",
    `${name} ${city}`,
    englishName ? `${englishName} China` : "",
  ].map((value) => cleanText(value)).filter(Boolean))];
  for (const query of queries) {
    const cached = unsplashMemory.get(query);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.value) return cached.value;
      continue;
    }
    const params = new URLSearchParams({ query, page: "1", per_page: "5", order_by: "relevant", orientation: "landscape", content_filter: "high" });
    const raw = await fetchJson(`https://api.unsplash.com/search/photos?${params}`, {
      headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" },
    }, 15000, "Unsplash 图片服务");
    const photo = (raw?.results || []).find((item: any) => item?.urls?.regular);
    if (!photo) {
      unsplashMemory.set(query, { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value: null });
      continue;
    }
    const value = {
      found: true, url: photo.urls.regular, source: "Unsplash", provider: "unsplash",
      sourceUrl: withUnsplashUtm(photo.links?.html),
      photographer: cleanText(photo.user?.name || photo.user?.username, "Unsplash 摄影师"),
      photographerUrl: withUnsplashUtm(photo.user?.links?.html),
      unsplashUrl: "https://unsplash.com/?utm_source=smart_travel_assistant&utm_medium=referral",
      verifiedName: name, matchQuality: "unsplash-relevant-search", queryUsed: query,
    };
    unsplashMemory.set(query, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value });
    return value;
  }
  return null;
}

async function wikipediaExactEntity(name: string, city: string) {
  const lookupNames = imageLookupNames(name, city);
  const titles = [...new Set(lookupNames.flatMap(item => [item, item.startsWith(city) ? "" : `${city}${item}`]).filter(Boolean))].slice(0, 6);
  const params = new URLSearchParams({
    action: "query", prop: "pageimages|info|langlinks", titles: titles.join("|"), redirects: "1",
    piprop: "thumbnail", pithumbsize: "960", inprop: "url", lllang: "en", lllimit: "1",
    format: "json", formatversion: "2", origin: "*",
  });
  const raw = await fetchJson(`https://zh.wikipedia.org/w/api.php?${params}`, {}, 15000, "中文维基百科精确图片");
  const ranked = (raw?.query?.pages || [])
    .filter((page: any) => !page?.missing)
    .map((page: any) => ({ page, score: poiMatchScore(page?.title, lookupNames) }))
    .filter((item: any) => item.score > 0)
    .sort((a: any, b: any) => b.score - a.score);
  const best = ranked[0]?.page;
  if (!best) return null;
  return {
    found: Boolean(secureImageUrl(best?.thumbnail?.source)),
    url: secureImageUrl(best?.thumbnail?.source),
    source: "Wikimedia 精确页面图片", provider: "wikimedia",
    sourceUrl: cleanText(best?.fullurl, `https://zh.wikipedia.org/wiki/${encodeURIComponent(cleanText(best?.title).replace(/ /g, "_"))}`),
    verifiedName: cleanText(best?.title, name), englishName: cleanText(best?.langlinks?.[0]?.title),
    matchQuality: "wikipedia-exact-title",
  };
}

function firstTransit(value: any) {
  const data = mcpData(value) || value || {};
  return data?.route?.transits?.[0] || data?.transits?.[0] || data?.route?.paths?.[0] || data?.paths?.[0] || null;
}

async function amapTransitFor(from: any, to: any, city: any, env: any = null) {
  const startedAt = Date.now();
  const officialKey = cleanText(env?.AMAP_WEB_KEY);
  if (officialKey) {
    try {
      const params = new URLSearchParams({
        key: officialKey,
        origin: `${from.lng},${from.lat}`,
        destination: `${to.lng},${to.lat}`,
        city: cleanText(city.adcode, city.name),
        cityd: cleanText(city.adcode, city.name),
        strategy: "0",
        extensions: "base",
      });
      const raw = await fetchJson(`https://restapi.amap.com/v3/direction/transit/integrated?${params}`, {}, 12000, "高德官方公交/地铁路线");
      const transit = raw?.route?.transits?.[0];
      const durationSeconds = Number(transit?.duration || 0);
      if (String(raw?.status) === "1" && durationSeconds > 0) return {
        status: "ready", mode: "公交 / 地铁", durationMin: Math.max(1, Math.round(durationSeconds / 60)),
        distanceM: Number(transit?.distance || raw?.route?.distance || 0) || null,
        source: "高德地图官方公交/地铁", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt,
      };
    } catch { /* 继续使用 MCP 兜底 */ }
  }
  try {
    const raw = await callMcp(AMAP_MCP, "maps_direction_transit_integrated", {
      origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`, city: city.name, cityd: city.name,
    }, { timeoutMs: 10000, cacheMs: 20 * 60 * 1000 });
    const transit: any = firstTransit(raw);
    if (!transit) return { status: "no-route", note: "高德 MCP 未返回可用公交方案" };
    const durationSeconds = Number(transit.duration || transit.cost?.duration || 0);
    return {
      status: "ready", mode: "公交 / 地铁", durationMin: durationSeconds ? Math.max(1, Math.round(durationSeconds / 60)) : null,
      distanceM: Number(transit.distance || 0) || null, source: "高德地图 MCP",
      fetchedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt,
    };
  } catch (error: any) {
    return { status: "unavailable", note: cleanText(error?.message, "高德地图 MCP 暂不可用") };
  }
}

async function enrichDayTransit(day: any, city: any, env: any, exactCache = new Map<string, Promise<any>>()) {
  const byName = new Map(day.items.map((item: any) => [item.name, item]));
  await Promise.all(day.blocks.filter((block: any) => block.type === "leg").map(async (block: any) => {
    const from = byName.get(block.from), to = byName.get(block.to);
    if (!from || !to) return;
    const key = `${Number(from.lng).toFixed(5)},${Number(from.lat).toFixed(5)}->${Number(to.lng).toFixed(5)},${Number(to.lat).toFixed(5)}`;
    if (!exactCache.has(key)) exactCache.set(key, amapTransitFor(from, to, city, env));
    const result: any = await exactCache.get(key);
    if (result.status === "ready") {
      block.mcpTransport = result;
      if (result.durationMin) {
        block.durationMin = result.durationMin;
        block.source = result.source;
        block.quality = "verified";
        block.fetchedAt = result.fetchedAt;
      }
    } else block.mcpStatus = result;
  }));
}

function reflowDayAfterTransit(day: any, profile: any) {
  const originalActivities = (day.blocks || [])
    .filter((block: any) => block.type !== "leg")
    .sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
  const legByPair = new Map((day.blocks || []).filter((block: any) => block.type === "leg").map((block: any) => [`${block.from}->${block.to}`, block]));
  const rebuilt: any[] = [];
  let cursor = timeToMinutes(profile.dayStart, 540);
  let previousSpot: any = null;
  let totalTransportMin = 0;
  for (const block of originalActivities) {
    const originalStart = timeToMinutes(block.startTime, cursor);
    const originalEnd = timeToMinutes(block.endTime, originalStart + Number(block.durationMin || 0));
    const duration = originalEnd > originalStart ? originalEnd - originalStart : Math.max(15, Number(block.durationMin || 0));
    const currentSpot = block.item || null;
    let leg: any = null;
    if (currentSpot && previousSpot) leg = legByPair.get(`${previousSpot.name}->${currentSpot.name}`) || null;
    const travelMinutes = Number(leg?.durationMin || 0);
    const start = Math.max(originalStart, cursor + travelMinutes);
    if (leg) {
      leg.startTime = minutesToTime(start - travelMinutes);
      leg.endTime = minutesToTime(start);
      rebuilt.push(leg);
      totalTransportMin += travelMinutes;
    }
    block.startTime = minutesToTime(start);
    block.endTime = minutesToTime(start + duration);
    block.durationMin = duration;
    if (currentSpot) {
      currentSpot.startTime = block.startTime;
      currentSpot.endTime = block.endTime;
      currentSpot.durationMin = duration;
      currentSpot.crowd = crowdRiskForVisit(currentSpot.crowd, block.startTime, day.date, day.weather);
      previousSpot = currentSpot;
    }
    rebuilt.push(block);
    cursor = start + duration;
  }
  day.blocks = rebuilt;
  day.items = originalActivities.map((block: any) => block.item).filter(Boolean);
  day.totalTransportMin = totalTransportMin;
  const dayEnd = timeToMinutes(profile.dayEnd, 1260);
  let overflow = Math.max(0, cursor - dayEnd);
  if (overflow > 0) {
    for (let index = rebuilt.length - 1; index >= 0 && overflow > 0; index -= 1) {
      const buffer = rebuilt[index];
      if (buffer.type !== "rest" || buffer.mealType || Number(buffer.durationMin || 0) <= 15) continue;
      const reduction = Math.min(overflow, Number(buffer.durationMin) - 15);
      buffer.durationMin -= reduction;
      buffer.endTime = minutesToTime(timeToMinutes(buffer.endTime, 0) - reduction);
      for (let nextIndex = index + 1; nextIndex < rebuilt.length; nextIndex += 1) {
        const later = rebuilt[nextIndex];
        later.startTime = minutesToTime(timeToMinutes(later.startTime, 0) - reduction);
        later.endTime = minutesToTime(timeToMinutes(later.endTime, 0) - reduction);
        if (later.item) {
          later.item.startTime = later.startTime;
          later.item.endTime = later.endTime;
          later.item.crowd = crowdRiskForVisit(later.item.crowd, later.startTime, day.date, day.weather);
        }
      }
      cursor -= reduction;
      overflow -= reduction;
    }
  }
  const conflicts: string[] = [];
  if (cursor > dayEnd) conflicts.push(`最终公交核验后结束时间 ${minutesToTime(cursor)} 超出用户要求 ${minutesToTime(dayEnd)}`);
  const lunch = originalActivities.find((block: any) => block.mealType === "lunch");
  if (!lunch || timeToMinutes(lunch.startTime, 0) > 13 * 60 + 30) conflicts.push("最终公交核验后午餐不在 13:30 前开始");
  const dinnerRequired = dayEnd >= 18 * 60;
  const dinner = originalActivities.find((block: any) => block.mealType === "dinner");
  if (dinnerRequired && (!dinner || timeToMinutes(dinner.startTime, 0) > 20 * 60)) conflicts.push("最终公交核验后缺少合理晚餐时段");
  const duplicateNames = day.items.map((item: any) => normalizeName(item.name)).filter((name: string, index: number, values: string[]) => values.indexOf(name) !== index);
  if (duplicateNames.length) conflicts.push("最终时间轴存在重复景点");
  for (const item of day.items) {
    const start = timeToMinutes(item.startTime, 0);
    const end = timeToMinutes(item.endTime, start);
    const open = openingRange(item.openingHours);
    if (open && (start < open[0] || end > open[1])) conflicts.push(`${item.name} 在最终交通顺延后与地图常规开放时间冲突`);
    if (item.timeRole === "nightscape" && start < timeToMinutes(day.weather?.sunset, 18 * 60)) conflicts.push(`${item.name} 在最终交通顺延后早于日落`);
    if (item.timeRole === "meal-landmark" && !((start >= 11 * 60 + 30 && start <= 13 * 60 + 30) || (start >= 17 * 60 + 30 && start <= 20 * 60))) conflicts.push(`${item.name} 在最终交通顺延后不处于饭点`);
  }
  day.conflicts = conflicts;
  if (conflicts.length) throw new Error(`最终公交/地铁核验后时间轴不可执行：第 ${day.day} 天 ${conflicts.join("；")}`);
}

function routeFallback(items: any[]) {
  let distance = 0;
  for (let i = 1; i < items.length; i += 1) distance += haversine(items[i - 1].lat, items[i - 1].lng, items[i].lat, items[i].lng);
  return { distance: Math.round(distance * 1.25), duration: Math.round(distance * 1.25 / 260), geometry: { coordinates: items.map(item => [item.lng, item.lat]) }, source: "坐标直线距离×1.25透明估算", quality: "estimated" };
}

async function routeFor(items: any[]) {
  if (items.length < 2) return { distance: 0, duration: 0, geometry: { coordinates: items.map(item => [item.lng, item.lat]) }, source: "单点行程", quality: "exact" };
  const coords = items.map(item => `${item.lng},${item.lat}`).join(";");
  try {
    const result = await fetchJson(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`, {}, 18000);
    const route = result?.routes?.[0];
    if (!route) throw new Error("no route");
    return { distance: Math.round(route.distance), duration: Math.round(route.duration), geometry: route.geometry, source: "OSRM 道路路由", quality: "routed" };
  } catch { return routeFallback(items); }
}

async function resolveLodgingAnchor(profile: any, city: any) {
  const label = cleanText(profile.lodgingArea, `${city.name}住宿区域`);
  if (!profile.lodgingArea) return { id: "hotel", name: label, lat: Number(city.lat), lng: Number(city.lng), source: city.source || "城市中心坐标" };
  try {
    const raw = await callMcp(AMAP_MCP, "maps_text_search", { keywords: label, city: city.name, types: "住宿服务|商务住宅" }, { timeoutMs: 9000, cacheMs: 30 * 60 * 1000 });
    const row = amapPoiRows(raw)[0];
    const location = cleanText(row?.location).split(",").map(Number);
    if (location.length === 2 && location.every(Number.isFinite)) return { id: "hotel", name: label, lat: location[1], lng: location[0], source: "高德地图 MCP" };
  } catch { /* use the verified city center */ }
  return { id: "hotel", name: label, lat: Number(city.lat), lng: Number(city.lng), source: city.source || "城市中心坐标" };
}

function transitEstimate(distanceM: number) {
  if (distanceM <= 1200) return Math.max(8, Math.round(distanceM / 75));
  return Math.max(15, Math.round(9 + distanceM * 1.18 / 330));
}

function fallbackMatrix(nodes: any[], fetchedAt: string, publicTransit = false) {
  const legs: any[] = [];
  for (let fromIndex = 0; fromIndex < nodes.length; fromIndex += 1) {
    for (let toIndex = 0; toIndex < nodes.length; toIndex += 1) {
      if (fromIndex === toIndex) continue;
      const distanceM = Math.round(haversine(nodes[fromIndex].lat, nodes[fromIndex].lng, nodes[toIndex].lat, nodes[toIndex].lng) * 1.25);
      legs.push({
        fromId: nodes[fromIndex].id, toId: nodes[toIndex].id,
        durationMin: publicTransit ? transitEstimate(distanceM) : Math.max(8, Math.round(distanceM / 260 / 60)),
        distanceM,
        source: publicTransit ? "公共交通距离模型（等待高德精确段）" : "坐标距离×1.25 透明估算",
        quality: "estimated", fetchedAt,
      });
    }
  }
  return { source: publicTransit ? "公共交通距离模型（等待高德精确段）" : "坐标距离×1.25 透明估算", fetchedAt, quality: "estimated", nodes, legs, verifiedLegCount: 0 };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await mapper(items[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildTrafficMatrix(profile: any, city: any, spots: any[], env: any) {
  const fetchedAt = new Date().toISOString();
  const publicTransit = /公交|地铁|公共交通/.test(cleanText(profile.transport));
  const anchor = await resolveLodgingAnchor(profile, city);
  const selected = uniqueSpots([
    ...spots.filter((spot: any) => spot.requiredByUser),
    ...spots.filter((spot: any) => !spot.requiredByUser),
  ]).filter((spot: any) => Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lng))).slice(0, 18);
  const nodes = [anchor, ...selected.map((spot: any) => ({ id: spot.id, name: spot.name, lat: Number(spot.lat), lng: Number(spot.lng) }))];
  if (nodes.length < 2) throw new Error("无法为候选景点建立交通矩阵：有效坐标不足");
  const coordinates = nodes.map((node: any) => `${node.lng},${node.lat}`).join(";");
  try {
    const data = await fetchJson(`${OSRM}/table/v1/driving/${coordinates}?annotations=duration,distance`, {}, 22000, "OSRM 交通矩阵");
    if (!Array.isArray(data?.durations) || !Array.isArray(data?.distances)) throw new Error("OSRM 未返回完整矩阵");
    const legs: any[] = [];
    nodes.forEach((from: any, fromIndex: number) => nodes.forEach((to: any, toIndex: number) => {
      if (fromIndex === toIndex) return;
      const seconds = Number(data.durations[fromIndex]?.[toIndex]);
      const distance = Number(data.distances[fromIndex]?.[toIndex]);
      if (!Number.isFinite(seconds) || !Number.isFinite(distance)) return;
      const distanceM = Math.round(distance);
      legs.push({
        fromId: from.id, toId: to.id,
        durationMin: publicTransit ? transitEstimate(distanceM) : Math.max(1, Math.round(seconds / 60)),
        distanceM,
        source: publicTransit ? "公共交通距离模型（规划前高德精确段补强）" : "OSRM Table 道路路由",
        quality: publicTransit ? "estimated" : "routed", fetchedAt,
      });
    }));
    if (legs.length < nodes.length * (nodes.length - 1) * 0.8) throw new Error("OSRM 矩阵缺失过多");
    if (!publicTransit) return { source: "OSRM Table 道路路由", fetchedAt, quality: "routed", nodes, legs, verifiedLegCount: legs.length };

    const nodeById = new Map(nodes.map((node: any) => [node.id, node]));
    const requiredIds = new Set(selected.filter((spot: any) => spot.requiredByUser).map((spot: any) => spot.id));
    const directed = legs
      .filter((leg: any) => leg.fromId === "hotel" || leg.toId === "hotel" || requiredIds.has(leg.fromId) || requiredIds.has(leg.toId))
      .sort((left: any, right: any) => left.distanceM - right.distanceM)
      .slice(0, 14);
    const nearest = nodes.flatMap((node: any) => legs
      .filter((leg: any) => leg.fromId === node.id && leg.toId !== "hotel")
      .sort((left: any, right: any) => left.distanceM - right.distanceM)
      .slice(0, 2));
    const pairKeys = new Set<string>();
    const queryLegs = [...directed, ...nearest].filter((leg: any) => {
      const key = `${leg.fromId}->${leg.toId}`;
      if (pairKeys.has(key)) return false;
      pairKeys.add(key);
      return true;
    }).slice(0, 6);
    const exact = await mapWithConcurrency(queryLegs, 4, async (leg: any) => ({
      leg,
      result: await amapTransitFor(nodeById.get(leg.fromId), nodeById.get(leg.toId), city, env),
    }));
    let verifiedLegCount = 0;
    for (const settled of exact) {
      if (settled.status !== "fulfilled" || settled.value.result?.status !== "ready" || !settled.value.result.durationMin) continue;
      const target = legs.find((leg: any) => leg.fromId === settled.value.leg.fromId && leg.toId === settled.value.leg.toId);
      if (!target) continue;
      target.durationMin = settled.value.result.durationMin;
      target.distanceM = settled.value.result.distanceM || target.distanceM;
      target.source = `${settled.value.result.source}（规划前）`;
      target.quality = "verified";
      target.fetchedAt = settled.value.result.fetchedAt || fetchedAt;
      verifiedLegCount += 1;
    }
    return {
      source: verifiedLegCount ? `高德公交/地铁规划前核验 ${verifiedLegCount} 段 + 其余公共交通透明估算` : "公共交通距离模型（高德本轮未返回）",
      fetchedAt, quality: "estimated", nodes, legs, verifiedLegCount,
    };
  } catch { return fallbackMatrix(nodes, fetchedAt, publicTransit); }
}

function matrixLeg(matrix: any, fromId: string, toId: string) {
  return matrix?.legs?.find((leg: any) => leg.fromId === fromId && leg.toId === toId)
    || matrix?.legs?.find((leg: any) => leg.fromId === toId && leg.toId === fromId)
    || null;
}

function planEvaluation(plan: any, profile: any, candidateCount: number) {
  const items = plan.daysPlan.flatMap((day: any) => day.items || []);
  const legs = plan.daysPlan.flatMap((day: any) => day.blocks || []).filter((block: any) => block.type === "leg");
  const required = profile.requiredAttractions || [];
  const requiredMatched = required.filter((name: string) => items.some((item: any) => {
    const expected = normalizeName(name), actual = normalizeName(item.name);
    return actual.includes(expected) || expected.includes(actual);
  }));
  const preferenceMatch = items.length ? Math.round(items.reduce((sum: number, item: any) => sum + Number(item.scoreBreakdown?.preference || 50), 0) / items.length) : 0;
  const transportMinutes = legs.reduce((sum: number, leg: any) => sum + Number(leg.durationMin || 0), 0);
  const longestLeg = legs.reduce((max: number, leg: any) => Math.max(max, Number(leg.durationMin || 0)), 0);
  const routeEfficiency = Math.max(0, Math.round(100 - transportMinutes / Math.max(1, profile.days) * 0.35 - Math.max(0, longestLeg - 45) * 0.5));
  const dailyCounts = plan.daysPlan.map((day: any) => day.items?.length || 0);
  const target = ["slow", "relax", "轻松"].includes(profile.pace) ? 2 : profile.pace === "tight" || profile.pace === "紧凑" ? 4 : 3;
  const comfort = Math.max(0, Math.round(100 - dailyCounts.reduce((sum: number, count: number) => sum + Math.abs(count - target) * 8, 0) / Math.max(1, profile.days) - Math.max(0, longestLeg - 60) * 0.4));
  const dataConfidence = items.length ? Math.round(items.reduce((sum: number, item: any) => sum + Number(item.scoreBreakdown?.dataCompleteness || 50), 0) / items.length) : 0;
  const constraintSatisfaction = required.length ? Math.round(requiredMatched.length / required.length * 100) : 100;
  const overall = Math.round(preferenceMatch * 0.35 + routeEfficiency * 0.25 + comfort * 0.2 + dataConfidence * 0.1 + constraintSatisfaction * 0.1);
  return {
    overall, preferenceMatch, routeEfficiency, comfort, dataConfidence, constraintSatisfaction,
    evidence: { candidateCount, selectedCount: items.length, transportMinutes, longestLegMinutes: longestLeg, dailyVisitCounts: dailyCounts, requiredMatched, requiredTotal: required.length },
    formula: "偏好匹配 35% · 路线效率 25% · 舒适度 20% · 数据完整度 10% · 硬约束 10%",
  };
}

function adjustmentDayIndexes(text: string, dayCount: number) {
  const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
  const matches = [...cleanText(text).matchAll(/(?:第\s*([一二三四五六七\d]+)\s*天|day\s*(\d+))/gi)];
  const indexes = matches.map(match => Number(match[2] || chinese[match[1]] || match[1]) - 1).filter(index => index >= 0 && index < dayCount);
  return [...new Set(indexes)];
}

async function hotelFallback(profile: any, city: any) {
  if (profile.lodgingArea) return { name: `${profile.lodgingArea}住宿区域`, reason: `用户指定住宿范围：${profile.lodgingArea}`, note: "未指定具体酒店；实时房价与余房需在预订平台复核", price: null };
  return { name: "未锁定具体酒店", reason: `建议在${city.name}行程中心区域筛选`, note: "未取得可靠实时住宿数据，因此不虚构酒店、房价或余房", price: null };
}

function mcpData(value: any) {
  if (value && typeof value === "object" && "data" in value) return value.data;
  return value;
}

function hotelRecord(row: any) {
  if (!row || typeof row !== "object") return null;
  const name = cleanText(row.hotel_name || row.name || row.title);
  if (!name) return null;
  return {
    name,
    address: cleanText(row.address || row.formatted_address),
    distance: Number(row.distance || row.distance_km),
    rating: cleanText(row.star || row.star_level || row.rating),
    hotelId: Number(row.hotel_id || row.id) || null,
    lat: Number(row.lat) || null,
    lng: Number(row.lng) || null,
    price: null,
    priceType: "酒店 MCP 暂未返回价格",
    priceVerifiedForDates: false,
    source: "MCPMarket 高端酒店查询（国内）",
    sourceUrl: "https://mcpmarket.cn/server/68ef4df83e8621b27597dafd",
  };
}

function hotelMoney(value: any) {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
}

function amapHotelRecord(row: any, fetchedAt: string) {
  if (!row || typeof row !== "object") return null;
  const name = cleanText(row.name);
  if (!name || !/住宿服务/.test(cleanText(row.type))) return null;
  const price = hotelMoney(row?.biz_ext?.lowest_price || row?.lowest_price);
  return {
    id: cleanText(row.id), name, address: cleanText(row.address), location: cleanText(row.location),
    distanceM: hotelMoney(row.distance), rating: cleanText(row?.biz_ext?.rating || row.rating),
    star: cleanText(row?.biz_ext?.star), price,
    priceType: price ? "高德 POI 最低参考价（非指定入住日期）" : "高德 POI 暂未返回参考价",
    priceVerifiedForDates: false, availability: "unknown", fetchedAt,
    source: "高德地图官方 Web 服务",
    sourceUrl: row.id ? `https://www.amap.com/place/${encodeURIComponent(row.id)}` : "https://www.amap.com/",
  };
}

function hotelProductSummary(value: any) {
  const text = cleanText(mcpData(value));
  if (!text) return { products: [], queryAvailability: "unknown", rawNote: "" };
  const products = text.split(/\r?\n/).map(line => {
    const price = hotelMoney(line.match(/(\d+(?:\.\d+)?)\s*元起/)?.[1]);
    const url = line.match(/https?:\/\/[^\s，。]+/)?.[0] || "";
    if (!price) return null;
    const title = cleanText(line.replace(/[:：]?https?:\/\/\S+/, "")).slice(0, 180);
    return { title, price, url };
  }).filter(Boolean).slice(0, 3);
  return {
    products,
    queryAvailability: /日期范围内.*不可用|套餐不可用|没有可用/.test(text) ? "unavailable" : "unknown",
    rawNote: /日期范围内.*不可用|套餐不可用|没有可用/.test(text) ? "指定日期套餐未确认可用；以下仅为当前在售产品参考" : "在售产品仅作参考，指定日期房态仍需复核",
  };
}

async function amapHotelsFor(env: any, city: any, location: string) {
  const key = cleanText(env?.AMAP_WEB_KEY);
  if (!key) return [];
  const fetchedAt = new Date().toISOString();
  const center = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(location) ? location : `${city.lng},${city.lat}`;
  const pages = await Promise.allSettled(["1", "2"].map(async page => {
    const params = new URLSearchParams({
      key, location: center, keywords: "酒店", types: "100000", radius: "10000",
      sortrule: "distance", extensions: "all", offset: "25", page,
    });
    const raw = await fetchJson(`https://restapi.amap.com/v3/place/around?${params}`, {}, 15000, "高德酒店 POI");
    if (String(raw?.status) !== "1") throw new Error(cleanText(raw?.info, "高德酒店 POI 未返回成功状态"));
    return raw?.pois || [];
  }));
  const seen = new Set<string>();
  const rows = pages.flatMap(page => page.status === "fulfilled" ? page.value : []);
  if (!rows.length && pages.every(page => page.status === "rejected")) throw (pages[0] as PromiseRejectedResult).reason;
  return rows.map((row: any) => amapHotelRecord(row, fetchedAt)).filter((row: any) => {
    const key = normalizeName(row?.name);
    return key && !seen.has(key) && seen.add(key);
  }).sort((a: any, b: any) => {
    if (Boolean(a.price) !== Boolean(b.price)) return a.price ? -1 : 1;
    const ratingDelta = Number(b.rating || 0) - Number(a.rating || 0);
    return Math.abs(ratingDelta) > 0.2 ? ratingDelta : Number(a.distanceM || 999999) - Number(b.distanceM || 999999);
  });
}

async function hotelFor(profile: any, city: any, env: any) {
  const area = cleanText(profile.lodgingArea, `${city.name}市中心`);
  const checkIn = profile.startDate;
  const checkOut = addDays(profile.startDate, Math.max(1, Number(profile.nights || profile.days - 1)));
  let location = `${city.lng},${city.lat}`;
  let mcpCandidates: any[] = [];
  let mcpError = "";
  try {
    const geocoded: any = await callMcp(HOTEL_MCP, "geocode", { address: `${city.name}${area}`, city: city.name }, { timeoutMs: 12000, cacheMs: 30 * 60 * 1000 });
    const geoRows = mcpData(geocoded)?.geocodes || mcpData(geocoded) || [];
    location = cleanText(Array.isArray(geoRows) ? geoRows[0]?.location : geoRows?.location, location);
    const nearby: any = await callMcp(HOTEL_MCP, "nearby_hotel", { location, distance: 10 }, { timeoutMs: 12000, cacheMs: 15 * 60 * 1000 });
    const rows = mcpData(nearby);
    mcpCandidates = (Array.isArray(rows) ? rows : rows?.hotels || []).map(hotelRecord).filter(Boolean).slice(0, 3);
    await Promise.all(mcpCandidates.filter(row => row.hotelId).map(async row => {
      try {
        const raw = await callMcp(HOTEL_MCP, "hotel_product", {
          hotel_id: row.hotelId,
          query: `${checkIn}入住，${checkOut}离店，${profile.partySize}位住客，查询当前在售住宿产品及价格`,
        }, { timeoutMs: 16000, cacheMs: 15 * 60 * 1000 });
        const summary: any = hotelProductSummary(raw);
        row.products = summary.products;
        row.availability = summary.queryAvailability;
        row.productNote = summary.rawNote;
        if (summary.products.length) {
          row.price = Math.min(...summary.products.map((item: any) => item.price));
          row.priceType = "酒店 MCP 在售套餐参考价（指定日期未确认）";
        }
      } catch (error: any) { row.productNote = `在售产品查询暂不可用：${cleanText(error?.message)}`; }
    }));
  } catch (error: any) {
    mcpError = cleanText(error?.message, "酒店 MCP 暂不可用");
  }

  let amapCandidates: any[] = [];
  let amapError = "";
  try { amapCandidates = await amapHotelsFor(env, city, location); }
  catch (error: any) { amapError = cleanText(error?.message, "高德酒店 POI 暂不可用"); }

  const mergedByName = new Map<string, any>();
  for (const row of [...amapCandidates, ...mcpCandidates]) {
    const key = normalizeName(row.name);
    if (!key) continue;
    const existing = mergedByName.get(key);
    if (!existing) { mergedByName.set(key, row); continue; }
    const useExistingPrice = Boolean(existing.price);
    mergedByName.set(key, {
      ...row, ...existing,
      price: existing.price || row.price || null,
      priceType: useExistingPrice ? existing.priceType : row.priceType,
      products: existing.products?.length ? existing.products : row.products,
      productNote: existing.productNote || row.productNote,
      source: `${existing.source} + ${row.source}`,
    });
  }
  const merged = [...mergedByName.values()];
  const priced = merged.filter((row: any) => row.price);
  const unpriced = merged.filter((row: any) => !row.price);
  const candidates = [...priced.slice(0, 5), ...unpriced.slice(0, Math.max(0, 5 - Math.min(5, priced.length)))].slice(0, 5);
  if (!candidates.length) {
    const fallback = await hotelFallback(profile, city);
    return {
      ...fallback, candidates: [], mcpStatus: mcpError ? "fallback" : "empty", source: "酒店 MCP + 高德酒店 POI",
      sourceUrl: "https://mcpmarket.cn/server/68ef4df83e8621b27597dafd", checkIn, checkOut, area,
      note: `已查询“${area}”附近酒店，但没有返回可核验候选。${[mcpError, amapError].filter(Boolean).join("；")}`,
    };
  }
  const pricedCount = candidates.filter((row: any) => row.price).length;
  return {
    name: `${candidates.length} 家附近真实住宿候选`,
    reason: `${area} · ${checkIn} 入住 / ${checkOut} 离店 · ${profile.partySize} 人`,
    note: pricedCount
      ? `${pricedCount} 家返回了可展示的最低/套餐参考价；均未核验为指定日期最终成交价，房态与税费请在下单页复核。`
      : "候选酒店已由地图核验，但数据源暂未返回可展示价格；不补写固定假价。",
    price: priced[0]?.price || null, pricedCount, candidates, checkIn, checkOut, area,
    mcpStatus: mcpCandidates.length ? "ready" : "partial",
    source: "高德地图官方酒店 POI + MCPMarket 酒店在售产品",
    sourceUrl: "https://mcpmarket.cn/server/68ef4df83e8621b27597dafd",
    fetchedAt: new Date().toISOString(), warnings: [mcpError, amapError].filter(Boolean),
  };
}

function diningRecord(row: any) {
  if (!row || typeof row !== "object") return null;
  const name = cleanText(row.name || row.title);
  const location = cleanText(row.location);
  if (!name) return null;
  const photos = Array.isArray(row.photos) ? row.photos : [];
  return {
    id: cleanText(row.id), name, address: cleanText(row.address), location,
    type: cleanText(row.type), distanceM: Number(row.distance) || null,
    photo: photos.map((item: any) => cleanText(typeof item === "string" ? item : item?.url)).find((value: string) => /^https:\/\//.test(value)) || null,
    source: "高德地图 MCP 实时 POI 查询",
  };
}

async function diningFor(city: string, lat: number, lng: number, mealType: string) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { status: "unavailable", candidates: [], message: "缺少路线锚点坐标" };
  try {
    const keyword = mealType === "dinner" ? "本地特色 晚餐" : "本地特色 午餐";
    const raw: any = await callMcp(AMAP_MCP, "maps_around_search", {
      location: `${lng},${lat}`, keywords: keyword, types: "餐饮服务", radius: "1500", city,
    }, { timeoutMs: 10000, cacheMs: 30 * 60 * 1000 });
    const rows = amapPoiRows(raw).map(diningRecord).filter(Boolean)
      .filter((row: any) => !/茶|咖啡|甜品|饮品/.test(`${row.name} ${row.type}`))
      .sort((a: any, b: any) => Number(a.distanceM ?? 999999) - Number(b.distanceM ?? 999999))
      .slice(0, 3);
    if (!rows.length) return { status: "empty", candidates: [], message: "路线附近未返回可核验餐饮 POI，保留自由用餐时间" };
    return { status: "ready", candidates: rows, message: `在路线锚点 1.5 公里内返回 ${rows.length} 个可核验候选`, fetchedAt: new Date().toISOString() };
  } catch (error: any) {
    return { status: "fallback", candidates: [], message: `高德餐饮查询暂不可用：${cleanText(error?.message)}；保留自由用餐时间` };
  }
}

const PLANNER_JSON_EXAMPLE = {
  variants: [{
    id: "hot", title: "经典覆盖", style: "经典", strategy: "代表性景点优先并控制跨区移动",
    days: [{
      day: 1, theme: "湖山经典", returnHotelTime: "19:30", totalActivityMin: 360, totalTransportMin: 45,
      activities: [
        { type: "attraction", spotId: "spot-id", startTime: "09:00", endTime: "11:00", durationMin: 120, reason: "必去且上午更顺路", evidenceRefs: ["spot-id", "traffic-matrix"] },
        { type: "meal", label: "午餐与休息", startTime: "12:00", endTime: "13:15", durationMin: 75, reason: "正常用餐，不跨区追店", evidenceRefs: [] },
      ],
    }],
  }],
};

const PLANNER_SYSTEM_PROMPT = `你是旅行约束求解器，不是旅游文案生成器。你的最终输出必须是一个严格 json 对象，不要输出 Markdown，不要输出思维过程。
硬规则：
1. 只允许使用输入候选池中的 spotId，绝不创造景点、酒店、价格、客流、开放时间、预约或交通数据。
2. requiredByUser=true 是所有方案的硬约束；Unknown 必须保持 Unknown。
3. 核心决策必须使用输入 trafficMatrix；交通、游玩、午餐、晚餐、休息与缓冲必须共同进入时间轴。
4. 先保证可执行性，再优化覆盖率。你负责完整时间决策，确定性程序只负责验收而不替你排时间。不得安排开放时间冲突、明显折返、超出每日时段或不合理夜景时段。
5. 三套方案分别优化：hot=经典覆盖；niche=自然摄影和合理光线/季节；relax=少景点、大缓冲、透明避峰风险。三套不能只换名字或交换一两个点。
6. 客流无官方实时数据时只可说 Unknown 或基于节假日/时段的 Prediction；不得宣称已实时避峰。
7. crowdRisk.score 是风险概率分值，不是在园人数；relax 优先低风险时段，必去点不可因此删除。hotness 仅表示近期关注度，seasonFit 仅表示时令适配，二者必须分别用于经典/摄影方案排序。
8. openingAlert 不等于已确认闭园，但必须在调整条件中提示用户核对原文；若候选点存在同类替代点，应给出 alternativeSpotIds。
9. 推荐理由必须简短并引用 evidenceRefs；每个景点要提供交通方式、矩阵耗时、调整条件和候选池内替代点。
10. 必须服从每个候选点的 timeRole、preferredWindows、avoidWindows 与 timeRationale：meal-landmark 必须用 type=meal 且保留 spotId，安排在 11:30—13:30 或 17:30—20:00；nightscape 必须在当日 sunset 后；展馆服从开放与预约；户外摄影优先早晚光线。
11. 每日必须包含正常午餐；若当天延续到 18:00 后还必须包含晚餐。活动之间不得重叠，交通时间不能被吞掉，午晚餐不是可删除的装饰块。
12. 每套天数严格等于 profile.days。若调用方要求三套，则输出 hot、niche、relax 且顺序不变；若明确要求“本次只生成某一套”，variants 必须只含该套，不能擅自输出另外两套。结构示例：${JSON.stringify(PLANNER_JSON_EXAMPLE)}`;

function normalizePlannerDraft(value: any, profile: any) {
  const variants = Array.isArray(value?.variants) ? value.variants.slice(0, 3) : [];
  return {
    variants: variants.map((variant: any, variantIndex: number) => ({
      id: ["hot", "niche", "relax"][variantIndex],
      title: cleanText(variant?.title, ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex]),
      style: cleanText(variant?.style, ["经典", "自然摄影", "轻松避峰"][variantIndex]),
      strategy: cleanText(variant?.strategy),
      days: (Array.isArray(variant?.days) ? variant.days : []).slice(0, profile.days).map((day: any, dayIndex: number) => ({
        day: dayIndex + 1,
        theme: cleanText(day?.theme, `第 ${dayIndex + 1} 天`),
        returnHotelTime: cleanText(day?.returnHotelTime, profile.dayEnd),
        totalActivityMin: clamp(day?.totalActivityMin, 0, 900),
        totalTransportMin: clamp(day?.totalTransportMin, 0, 600),
        activities: (Array.isArray(day?.activities) ? day.activities : []).slice(0, 12).map((activity: any) => ({
          type: ["attraction", "meal", "rest"].includes(cleanText(activity?.type)) ? cleanText(activity.type) : "rest",
          spotId: cleanText(activity?.spotId) || undefined,
          label: cleanText(activity?.label) || undefined,
          startTime: cleanText(activity?.startTime), endTime: cleanText(activity?.endTime),
          durationMin: clamp(activity?.durationMin, 15, 360),
          transportFromPrevious: activity?.transportFromPrevious ? {
            mode: cleanText(activity.transportFromPrevious.mode, "公共交通"),
            durationMin: clamp(activity.transportFromPrevious.durationMin, 1, 360),
            matrixKey: cleanText(activity.transportFromPrevious.matrixKey) || undefined,
          } : undefined,
          reason: cleanText(activity?.reason, "依据候选景点知识包与交通矩阵"),
          evidenceRefs: list(activity?.evidenceRefs).slice(0, 8),
          alternativeSpotIds: list(activity?.alternativeSpotIds).slice(0, 4),
          adjustmentCondition: cleanText(activity?.adjustmentCondition) || undefined,
        })),
      })),
    })),
  };
}

function normalizePlannerVariant(value: any, profile: any, variantIndex: number) {
  const rawVariant = Array.isArray(value?.variants) ? value.variants[0] : value?.variant || value;
  const normalized = normalizePlannerDraft({ variants: [rawVariant] }, profile).variants[0];
  if (!normalized) return null;
  return {
    ...normalized,
    id: ["hot", "niche", "relax"][variantIndex],
    title: cleanText(rawVariant?.title, ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex]),
    style: cleanText(rawVariant?.style, ["经典", "自然摄影", "轻松避峰"][variantIndex]),
  };
}

function bindTrafficMatrixFacts(draft: any, knowledge: any) {
  const matrix = knowledge?.trafficMatrix;
  if (!matrix?.legs?.length) return draft;
  for (const variant of draft.variants || []) {
    for (const day of variant.days || []) {
      const spotActivities = (day.activities || [])
        .filter((activity: any) => Boolean(activity.spotId))
        .sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
      for (let index = 1; index < spotActivities.length; index += 1) {
        const previous = spotActivities[index - 1];
        const current = spotActivities[index];
        const leg = matrix.legs.find((item: any) => item.fromId === previous.spotId && item.toId === current.spotId)
          || matrix.legs.find((item: any) => item.fromId === current.spotId && item.toId === previous.spotId);
        if (!leg || current.transportFromPrevious) continue;
        current.transportFromPrevious = {
          mode: "公共交通 / 步行（以地图复核为准）",
          durationMin: Number(leg.durationMin),
          matrixKey: `${previous.spotId}->${current.spotId}`,
        };
      }
      day.totalTransportMin = spotActivities.slice(1).reduce((sum: number, activity: any) => sum + Number(activity.transportFromPrevious?.durationMin || 0), 0);
    }
  }
  return draft;
}

function legalizePlannerTimelines(draft: any, knowledge: any) {
  const matrix = knowledge?.trafficMatrix;
  const spotMap = new Map((knowledge?.spots || []).map((spot: any) => [spot.id, spot]));
  let shiftedActivities = 0;
  let shiftedMinutes = 0;
  for (const variant of draft.variants || []) {
    for (const day of variant.days || []) {
      const ordered = [...(day.activities || [])]
        .sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
      let previousEnd = 0;
      let previousSpot: any = null;
      for (const activity of ordered) {
        const originalStart = timeToMinutes(activity.startTime, previousEnd);
        const originalEnd = timeToMinutes(activity.endTime, originalStart + Number(activity.durationMin || 0));
        const durationFromTimes = originalEnd - originalStart;
        const duration = durationFromTimes > 0 ? durationFromTimes : Math.max(15, Number(activity.durationMin || 0));
        let minimumStart = previousEnd;
        const semanticSpot: any = activity.spotId ? spotMap.get(activity.spotId) : null;
        if (semanticSpot?.timeRole === "nightscape") {
          minimumStart = Math.max(minimumStart, timeToMinutes(knowledge?.weather?.[day.day - 1]?.sunset, 18 * 60));
        }
        if (semanticSpot?.timeRole === "meal-landmark") {
          if (originalStart < 11 * 60 + 30) minimumStart = Math.max(minimumStart, 11 * 60 + 30);
          else if (originalStart > 13 * 60 + 30 && originalStart < 17 * 60 + 30) minimumStart = Math.max(minimumStart, 17 * 60 + 30);
        }
        if (activity.spotId && previousSpot?.spotId && matrix?.legs?.length) {
          const leg = matrix.legs.find((item: any) => item.fromId === previousSpot.spotId && item.toId === activity.spotId)
            || matrix.legs.find((item: any) => item.fromId === activity.spotId && item.toId === previousSpot.spotId);
          if (leg) minimumStart = Math.max(minimumStart, previousSpot.end + Number(leg.durationMin));
        }
        const legalizedStart = Math.max(originalStart, minimumStart);
        if (legalizedStart > originalStart) {
          shiftedActivities += 1;
          shiftedMinutes += legalizedStart - originalStart;
          activity.startTime = minutesToTime(legalizedStart);
          activity.endTime = minutesToTime(legalizedStart + duration);
        }
        activity.durationMin = duration;
        const legalizedEnd = legalizedStart + duration;
        previousEnd = legalizedEnd;
        if (activity.spotId) previousSpot = { spotId: activity.spotId, end: legalizedEnd };
      }
      day.activities = ordered;
    }
  }
  return { shiftedActivities, shiftedMinutes };
}

export function applyFinalTimelineSafetyRepair(draft: any, knowledge: any) {
  const profile = knowledge?.profile || {};
  const startLimit = timeToMinutes(profile.dayStart, 9 * 60);
  const endLimit = timeToMinutes(profile.dayEnd, 21 * 60);
  const spotMap = new Map((knowledge?.spots || []).map((spot: any) => [spot.id, spot]));
  const matrix = knowledge?.trafficMatrix;
  let insertedLunches = 0;
  let removedFlexibleStops = 0;
  let reflowedActivities = 0;

  const reflow = (day: any, activities: any[]) => {
    const ordered = [...activities].sort((left: any, right: any) => timeToMinutes(left.startTime, startLimit) - timeToMinutes(right.startTime, startLimit));
    let cursor = startLimit;
    let previousSpot: any = null;
    for (const activity of ordered) {
      const originalStart = timeToMinutes(activity.startTime, cursor);
      const originalEnd = timeToMinutes(activity.endTime, originalStart + Number(activity.durationMin || 60));
      const semanticSpot: any = activity.spotId ? spotMap.get(activity.spotId) : null;
      let duration = Math.max(15, originalEnd - originalStart || Number(activity.durationMin || 60));
      if (activity.type === "meal") duration = Math.min(90, Math.max(60, duration));
      else if (activity.type === "rest") duration = Math.min(45, Math.max(20, duration));
      else duration = Math.min(semanticSpot?.requiredByUser ? 120 : 100, Math.max(semanticSpot?.requiredByUser ? 60 : 45, duration));
      let minimumStart = cursor;
      const open = openingRange(semanticSpot?.openingHours);
      if (open) minimumStart = Math.max(minimumStart, open[0]);
      if (activity.type === "meal" && !activity.spotId && /午餐/.test(cleanText(activity.label))) minimumStart = Math.max(minimumStart, 11 * 60 + 30);
      if (semanticSpot?.timeRole === "meal-landmark") {
        activity.type = "meal";
        minimumStart = Math.max(minimumStart, originalStart <= 14 * 60 ? 11 * 60 + 30 : 17 * 60 + 30);
      }
      if (semanticSpot?.timeRole === "nightscape") minimumStart = Math.max(minimumStart, timeToMinutes(knowledge?.weather?.[day.day - 1]?.sunset, 18 * 60));
      if (activity.spotId && previousSpot?.spotId && matrix?.legs?.length) {
        const leg = matrix.legs.find((item: any) => item.fromId === previousSpot.spotId && item.toId === activity.spotId)
          || matrix.legs.find((item: any) => item.fromId === activity.spotId && item.toId === previousSpot.spotId);
        if (leg) {
          minimumStart = Math.max(minimumStart, previousSpot.end + Number(leg.durationMin));
          activity.transportFromPrevious = { mode: "公共交通 / 步行（以地图复核为准）", durationMin: Number(leg.durationMin), matrixKey: `${previousSpot.spotId}->${activity.spotId}` };
        }
      }
      const start = minimumStart;
      activity.startTime = minutesToTime(start);
      activity.endTime = minutesToTime(start + duration);
      activity.durationMin = duration;
      cursor = start + duration;
      if (activity.spotId) previousSpot = { spotId: activity.spotId, end: cursor };
      reflowedActivities += 1;
    }
    day.activities = ordered;
    day.returnHotelTime = minutesToTime(Math.min(endLimit, Math.max(cursor, timeToMinutes(day.returnHotelTime, cursor))));
    return cursor;
  };

  for (const variant of draft.variants || []) {
    for (const day of variant.days || []) {
      let activities = [...(day.activities || [])];
      const hasLunch = activities.some((activity: any) => activity.type === "meal" && (() => { const start = timeToMinutes(activity.startTime, -1); return start >= 11 * 60 && start <= 13 * 60 + 30; })());
      if (!hasLunch) {
        activities.push({ type: "meal", label: "午餐与休息", startTime: "12:00", endTime: "13:00", durationMin: 60, reason: "最终编译器补齐正常午餐，不跨区追店", evidenceRefs: [] });
        insertedLunches += 1;
      }
      let end = reflow(day, activities);
      while (end > endLimit) {
        const removable = [...day.activities].reverse().find((activity: any) => {
          if (!activity.spotId) return activity.type === "rest";
          const spot: any = spotMap.get(activity.spotId);
          return !spot?.requiredByUser && !["meal-landmark", "nightscape"].includes(cleanText(spot?.timeRole));
        });
        if (!removable) break;
        activities = day.activities.filter((activity: any) => activity !== removable);
        removedFlexibleStops += 1;
        end = reflow(day, activities);
      }
    }
  }
  return { insertedLunches, removedFlexibleStops, reflowedActivities };
}

async function generatePlannerDraft(profile: any, knowledge: any, env: any, replanContext: any) {
  assertPlannerContext(knowledge);
  const modelAudit = { plannerModel: aiPrimaryModel(env, "planner"), repairModel: aiPrimaryModel(env, "repair"), toolCalls: [] as any[], formatRepairs: 0, repairRounds: 0, deepReasoningUsed: profile.deepReasoning !== false, degraded: false, degradationReason: "", compilerIssues: [] as any[] };
  let draft: any;
  const objectives = [
    { id: "hot", name: "经典覆盖", goal: "优先代表性与必去覆盖，控制跨区移动；不要把购物 POI 当景点。" },
    { id: "niche", name: "自然摄影", goal: "优先自然、摄影、季节证据和合理光线；恶劣天气给候选池内室内替代。" },
    { id: "relax", name: "轻松避峰", goal: "降低每日景点数、增加缓冲；客流未知时不得宣称实时避峰成功。" },
  ];
  const verificationQueries = [...new Set([
    ...list(profile.requiredAttractions).slice(0, 3),
    ...(list(profile.seasonalNeeds).length ? [`${profile.city} ${list(profile.seasonalNeeds).slice(0, 2).join(" ")}`] : []),
  ])].slice(0, 3);
  const verifiedWebContext = (await Promise.all(verificationQueries.map(async (query) => {
    try {
      const output = await searchVerifiedTravelContext(query, profile.city, env);
      return {
        tool: "search_verified_travel_context", query, resultCount: output.sources?.length || 0,
        fetchedAt: output.fetchedAt || new Date().toISOString(), sources: (output.sources || []).slice(0, 8), unavailable: output.unavailable || [],
      };
    } catch (error: any) {
      return { tool: "search_verified_travel_context", query, resultCount: 0, fetchedAt: new Date().toISOString(), sources: [], unavailable: [{ name: "network", reason: cleanText(error?.message) }] };
    }
  }))).filter(Boolean);
  modelAudit.toolCalls.push(...verifiedWebContext);
  const plannerInput = { task: replanContext ? "局部重规划" : "首次规划", objectives, knowledge, verifiedWebContext, replanContext };
  let decisionMemo = "";
  if (profile.deepReasoning !== false) {
    try {
      const deliberation = await aiRequest(env, {
        purpose: "planner", thinking: true, allowReasoningOnly: true, maxTokens: 1200, requestTimeoutMs: 45000,
        messages: [
          { role: "system", content: "你是 DeepSeek V4 Pro 行程决策器。先深度分析约束，只需给后续成稿模型一份精炼决策备忘录，不输出完整 JSON。重点判断必去覆盖、餐饮型地点饭点、夜景日落后时段、开放时间、天气、交通间隔、午晚餐、缓冲和三方案差异。不得添加输入中没有的事实。" },
          { role: "user", content: JSON.stringify(plannerInput) },
        ],
      });
      decisionMemo = cleanText(deliberation.content || deliberation.reasoningContent).slice(0, 6000);
    } catch (error: any) {
      modelAudit.compilerIssues.push({ code: "DEEP_REASONING_BUDGET", message: `V4 Pro 深度分析未在 45 秒预算内形成备忘录，继续由同一 V4 Pro 成稿并接受编译器校验：${cleanText(error?.message)}` });
    }
  }
  await new Promise(resolve => setTimeout(resolve, 1200));
  draft = { variants: [] };
  // Generate each alternative separately. This keeps four-day timelines below
  // upstream output limits while every call still shares the same V4 Pro memo,
  // evidence pack and already-generated variant summaries.
  for (let variantIndex = 0; variantIndex < objectives.length; variantIndex += 1) {
    const objective = objectives[variantIndex];
    if (variantIndex > 0) await new Promise(resolve => setTimeout(resolve, 900));
    try {
      const supplemental = await aiJson(env, {
        purpose: "planner", thinking: false, maxTokens: 5200, requestTimeoutMs: 120000,
        messages: [
          { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n后端已完成联网取证，verifiedWebContext、天气和交通矩阵均在输入中。本次只生成 ${objective.id}=${objective.goal} 这一套方案，仍须覆盖所有必去点和全部旅行日期。输出 {"variants":[一套完整方案]}，不得输出另外两套。${decisionMemo ? `\n共享 V4 Pro 决策备忘录（不是新增事实）：\n${decisionMemo}` : ""}` },
          { role: "user", content: JSON.stringify({ ...plannerInput, objective, existingVariantSummaries: draft.variants.map((variant: any) => ({ id: variant.id, strategy: variant.strategy, spotIds: variant.days.flatMap((day: any) => day.activities.map((activity: any) => activity.spotId).filter(Boolean)) })), instruction: `只输出 ${objective.id} 的完整 JSON 方案，并与已有方案形成实质差异。` }) },
        ],
      });
      const variant = normalizePlannerVariant(supplemental.value, profile, variantIndex);
      if (!variant?.days?.length) throw new Error(`${objective.id} 没有返回完整日期`);
      draft.variants.push(variant);
      modelAudit.plannerModel = supplemental.model;
      if (supplemental.formatRepaired) modelAudit.formatRepairs += 1;
    } catch (error: any) {
      throw new Error(`DeepSeek V4 Pro 未能补全 ${objective.name} 方案：${cleanText(error?.message, "规划模型调用失败")}`);
    }
  }
  if (draft.variants.length !== 3) throw new Error(`DeepSeek V4 Pro 未能生成可靠时间轴：最终只有 ${draft.variants.length} 套方案`);
  bindTrafficMatrixFacts(draft, knowledge);
  const initialLegalization = legalizePlannerTimelines(draft, knowledge);
  if (initialLegalization.shiftedActivities) modelAudit.compilerIssues.push({
    code: "TIMELINE_LEGALIZED", severity: "warning",
    message: `Travel Compiler 未改变景点选择或顺序，按交通矩阵顺延 ${initialLegalization.shiftedActivities} 个节点，共 ${initialLegalization.shiftedMinutes} 分钟`,
  });

  let audit = auditPlannerDraft(draft, knowledge);
  for (let round = 0; round < 2 && audit.hardIssues.length > 0; round += 1) {
    const affectedIds = new Set(audit.hardIssues.map((issue: any) => cleanText(issue.variantId)).filter(Boolean));
    if (!affectedIds.size) affectedIds.add("relax");
    for (const variantId of affectedIds) {
      const variantIndex = ["hot", "niche", "relax"].indexOf(variantId);
      if (variantIndex < 0 || !draft.variants[variantIndex]) continue;
      const variantIssues = audit.hardIssues.filter((issue: any) => !issue.variantId || issue.variantId === variantId);
      try {
        await new Promise(resolve => setTimeout(resolve, 900));
        const repaired = await aiJson(env, {
          purpose: "repair", thinking: false, maxTokens: 5600, requestTimeoutMs: 90000,
          messages: [
            { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n你现在是单方案冲突修复器。只输出 {"variants":[修复后的 ${variantId} 完整方案]}。逐项消除问题清单，保留必去点；不得修改为算法占位或删除正常用餐。` },
            { role: "user", content: JSON.stringify({ knowledge, variant: draft.variants[variantIndex], otherVariantSummaries: draft.variants.filter((_: any, index: number) => index !== variantIndex).map((variant: any) => ({ id: variant.id, spotIds: variant.days.flatMap((day: any) => day.activities.map((activity: any) => activity.spotId).filter(Boolean)) })), issues: variantIssues, hardConstraints: { requiredAttractions: profile.requiredAttractions, dayStart: profile.dayStart, dayEnd: profile.dayEnd, days: profile.days }, softConstraints: { preferences: profile.preferences, pace: profile.pace }, replanContext }) },
          ],
        });
        const repairedVariant = normalizePlannerVariant(repaired.value, profile, variantIndex);
        if (!repairedVariant?.days?.length) throw new Error(`${variantId} 修复结果缺少完整日期`);
        draft.variants[variantIndex] = repairedVariant;
        bindTrafficMatrixFacts(draft, knowledge);
        const repairedLegalization = legalizePlannerTimelines(draft, knowledge);
        if (repairedLegalization.shiftedActivities) modelAudit.compilerIssues.push({
          code: "TIMELINE_LEGALIZED_AFTER_REPAIR", severity: "warning", variantId,
          message: `AI 局部修复后按交通矩阵顺延 ${repairedLegalization.shiftedActivities} 个节点，共 ${repairedLegalization.shiftedMinutes} 分钟`,
        });
        modelAudit.repairModel = repaired.model;
        if (repaired.formatRepaired) modelAudit.formatRepairs += 1;
      } catch (error: any) {
        modelAudit.compilerIssues.push({ code: "REPAIR_FAILED", variantId, message: cleanText(error?.message) });
      }
    }
    modelAudit.repairRounds += 1;
    audit = auditPlannerDraft(draft, knowledge);
  }
  modelAudit.compilerIssues.push(...audit.issues);
  if (audit.hardIssues.length) {
    const summary = audit.hardIssues.slice(0, 8).map((issue: any) => `${cleanText(issue.code)}：${cleanText(issue.message)}`).join("；");
    throw new Error(`DeepSeek V4 Pro 经 ${modelAudit.repairRounds} 轮修复后仍有 ${audit.hardIssues.length} 个时间或约束冲突，系统拒绝返回低质量算法拼接行程${summary ? `。主要问题：${summary}` : ""}`);
  }
  return { draft, audit, modelAudit };
}

const WORKFLOW_OBJECTIVES = [
  { id: "hot", name: "经典覆盖", goal: "优先代表性与必去覆盖，控制跨区移动；不要把购物 POI 当景点。" },
  { id: "niche", name: "自然摄影", goal: "优先自然、摄影、季节证据和合理光线；恶劣天气给候选池内室内替代。" },
  { id: "relax", name: "轻松避峰", goal: "降低每日景点数、增加缓冲；客流未知时不得宣称实时避峰成功。" },
];

function newWorkflowPlannerState(profile: any, env: any) {
  return {
    verifiedWebContext: [], decisionMemo: "", draft: { variants: [] }, audit: null,
    modelAudit: { plannerModel: aiPrimaryModel(env, "planner"), repairModel: aiPrimaryModel(env, "repair"), toolCalls: [], formatRepairs: 0, repairRounds: 0, deepReasoningUsed: profile.deepReasoning !== false, degraded: false, degradationReason: "", compilerIssues: [] },
  };
}

async function runPlannerWorkflowStage(stage: string, profile: any, knowledge: any, env: any, replanContext: any, previousState?: any, retryContext?: any) {
  assertPlannerContext(knowledge);
  const state = previousState || newWorkflowPlannerState(profile, env);
  const plannerInput = { task: replanContext ? "局部重规划" : "首次规划", objectives: WORKFLOW_OBJECTIVES, knowledge, verifiedWebContext: state.verifiedWebContext, replanContext };
  if (stage === "planner_research") {
    const verificationQueries = [...new Set([
      ...list(profile.requiredAttractions).slice(0, 3),
      ...(list(profile.seasonalNeeds).length ? [`${profile.city} ${list(profile.seasonalNeeds).slice(0, 2).join(" ")}`] : []),
    ])].slice(0, 3);
    state.verifiedWebContext = (await Promise.all(verificationQueries.map(async (query) => {
      try {
        const output = await searchVerifiedTravelContext(query, profile.city, env);
        return { tool: "search_verified_travel_context", query, resultCount: output.sources?.length || 0, fetchedAt: output.fetchedAt || new Date().toISOString(), sources: (output.sources || []).slice(0, 8), unavailable: output.unavailable || [] };
      } catch (error: any) {
        return { tool: "search_verified_travel_context", query, resultCount: 0, fetchedAt: new Date().toISOString(), sources: [], unavailable: [{ name: "network", reason: cleanText(error?.message) }] };
      }
    }))).filter(Boolean);
    state.modelAudit.toolCalls = state.verifiedWebContext;
    return state;
  }
  if (stage === "planner_memo") {
    if (profile.deepReasoning === false) return state;
    try {
      const deliberation = await aiRequest(env, {
        purpose: "planner", thinking: true, allowReasoningOnly: true, maxTokens: 1200, requestTimeoutMs: 150000,
        messages: [
          { role: "system", content: "你是 DeepSeek V4 Pro 行程决策器。形成精炼决策备忘录，不输出完整 JSON。重点判断必去覆盖、餐饮型地点饭点、夜景日落后时段、开放时间、天气、交通间隔、午晚餐、缓冲和三方案差异。不得添加输入中没有的事实。" },
          { role: "user", content: JSON.stringify({ ...plannerInput, verifiedWebContext: state.verifiedWebContext }) },
        ],
      });
      state.decisionMemo = cleanText(deliberation.content || deliberation.reasoningContent).slice(0, 6000);
    } catch (error: any) {
      state.modelAudit.compilerIssues.push({ code: "DEEP_REASONING_BUDGET", message: `V4 Pro 深度分析未形成备忘录，继续由同一模型成稿：${cleanText(error?.message)}` });
    }
    return state;
  }
  if (stage.startsWith("variant_")) {
    const variantId = stage.slice("variant_".length);
    const variantIndex = WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === variantId);
    const objective = WORKFLOW_OBJECTIVES[variantIndex];
    if (!objective) throw new Error(`未知方案阶段：${stage}`);
    if (state.draft.variants.some((variant: any) => variant.id === variantId)) return state;
    const supplemental = await aiJson(env, {
      purpose: "planner", thinking: false, maxTokens: 5400, requestTimeoutMs: 150000,
      messages: [
        { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n后端已完成联网取证。本次只生成 ${objective.id}=${objective.goal} 这一套方案，仍须覆盖所有必去点和全部旅行日期。输出 {"variants":[一套完整方案]}。${retryContext?.attempts ? `\n这是结构校验失败后的最后一次定向重试。上次错误：${cleanText(retryContext.lastError)}。必须输出正好 ${profile.days} 个 days，day 从 1 连续到 ${profile.days}，每一天都有 activities；禁止 daysPlan、itinerary 等替代字段。` : ""}${state.decisionMemo ? `\n共享 V4 Pro 决策备忘录（不是新增事实）：\n${state.decisionMemo}` : ""}` },
        { role: "user", content: JSON.stringify({ ...plannerInput, verifiedWebContext: state.verifiedWebContext, objective, existingVariantSummaries: state.draft.variants.map((variant: any) => ({ id: variant.id, strategy: variant.strategy, spotIds: variant.days.flatMap((day: any) => day.activities.map((activity: any) => activity.spotId).filter(Boolean)) })), requiredOutputShape: { variants: [{ id: objective.id, days: Array.from({ length: profile.days }, (_, index) => ({ day: index + 1, activities: "non-empty array" })) }] }, instruction: `只输出 ${objective.id} 的完整 JSON 方案，并与已有方案形成实质差异。` }) },
      ],
    });
    const variant = normalizePlannerVariant(supplemental.value, profile, variantIndex);
    if (!variant?.days?.length) throw new Error(`${objective.name}没有返回完整日期`);
    state.draft.variants.push(variant);
    state.draft.variants.sort((left: any, right: any) => WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === left.id) - WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === right.id));
    state.modelAudit.plannerModel = supplemental.model;
    if (supplemental.formatRepaired) state.modelAudit.formatRepairs += 1;
    return state;
  }
  if (stage.startsWith("audit_")) {
    if (state.draft.variants.length !== 3) throw new Error(`V4 Pro 方案检查点不完整：${state.draft.variants.length}/3`);
    bindTrafficMatrixFacts(state.draft, knowledge);
    const legalization = legalizePlannerTimelines(state.draft, knowledge);
    if (legalization.shiftedActivities) state.modelAudit.compilerIssues.push({ code: "TIMELINE_LEGALIZED", severity: "warning", message: `Travel Compiler 按交通矩阵顺延 ${legalization.shiftedActivities} 个节点，共 ${legalization.shiftedMinutes} 分钟` });
    state.audit = auditPlannerDraft(state.draft, knowledge);
    if (stage === "audit_final") {
      if (state.audit.hardIssues.some((issue: any) => ["MEAL_MISSING", "LUNCH_MISSING", "TIME_RANGE", "ACTIVITY_OVERLAP", "TRANSIT_GAP", "RETURN_TOO_LATE"].includes(cleanText(issue.code)))) {
        const safetyRepair = applyFinalTimelineSafetyRepair(state.draft, knowledge);
        bindTrafficMatrixFacts(state.draft, knowledge);
        state.audit = auditPlannerDraft(state.draft, knowledge);
        state.modelAudit.compilerIssues.push({ code: "FINAL_TIMELINE_SAFETY_REPAIR", severity: "warning", message: `最终编译器补齐午餐 ${safetyRepair.insertedLunches} 次、移除 ${safetyRepair.removedFlexibleStops} 个非必选超时节点，并按交通矩阵重排时间；AI 仍负责景点与方案决策` });
      }
      state.modelAudit.compilerIssues.push(...state.audit.issues);
      if (state.audit.hardIssues.length) {
        const summary = state.audit.hardIssues.slice(0, 8).map((issue: any) => `${cleanText(issue.code)}：${cleanText(issue.message)}`).join("；");
        throw new Error(`V4 Pro 经两轮修复后仍有 ${state.audit.hardIssues.length} 个硬冲突${summary ? `：${summary}` : ""}`);
      }
    }
    return state;
  }
  if (stage.startsWith("repair_round_")) {
    if (!state.audit) state.audit = auditPlannerDraft(state.draft, knowledge);
    if (!state.audit.hardIssues.length) return state;
    const affectedIds = new Set(state.audit.hardIssues.map((issue: any) => cleanText(issue.variantId)).filter(Boolean));
    if (!affectedIds.size) affectedIds.add("relax");
    for (const variantId of affectedIds) {
      const variantIndex = WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === variantId);
      if (variantIndex < 0 || !state.draft.variants[variantIndex]) continue;
      const issues = state.audit.hardIssues.filter((issue: any) => !issue.variantId || issue.variantId === variantId);
      const repaired = await aiJson(env, {
        purpose: "repair", thinking: false, maxTokens: 5600, requestTimeoutMs: 150000,
        messages: [
          { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n你是单方案冲突修复器。只输出 {"variants":[修复后的 ${variantId} 完整方案]}。逐项消除问题并保留必去点和正常用餐。` },
          { role: "user", content: JSON.stringify({ knowledge, variant: state.draft.variants[variantIndex], issues, hardConstraints: { requiredAttractions: profile.requiredAttractions, dayStart: profile.dayStart, dayEnd: profile.dayEnd, days: profile.days }, replanContext }) },
        ],
      });
      const repairedVariant = normalizePlannerVariant(repaired.value, profile, variantIndex);
      if (!repairedVariant?.days?.length) throw new Error(`${variantId} 修复结果缺少完整日期`);
      state.draft.variants[variantIndex] = repairedVariant;
      state.modelAudit.repairModel = repaired.model;
      if (repaired.formatRepaired) state.modelAudit.formatRepairs += 1;
    }
    state.modelAudit.repairRounds += 1;
    return state;
  }
  return state;
}

function planDayFromDraft(dayDraft: any, dayIndex: number, spotsById: Map<string, any>, matrix: any, weather: any, profile: any) {
  const blocks: any[] = [];
  const items: any[] = [];
  let previousSpot: any = null;
  const ordered = [...(dayDraft.activities || [])].sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
  for (const activity of ordered) {
    if (activity.type === "attraction" || (activity.type === "meal" && activity.spotId)) {
      const base = spotsById.get(activity.spotId);
      if (!base) continue;
      if (previousSpot) {
        const leg = matrixLeg(matrix, previousSpot.id, base.id);
        const durationMin = Number(leg?.durationMin || activity.transportFromPrevious?.durationMin || 20);
        const attractionStart = timeToMinutes(activity.startTime, timeToMinutes(profile.dayStart, 540));
        blocks.push({ type: "leg", from: previousSpot.name, to: base.name, startTime: minutesToTime(Math.max(0, attractionStart - durationMin)), endTime: activity.startTime, durationMin, distanceM: Number(leg?.distanceM || 0), source: cleanText(leg?.source, "交通矩阵"), quality: cleanText(leg?.quality, "estimated"), fetchedAt: leg?.fetchedAt, mode: cleanText(activity.transportFromPrevious?.mode, "公共交通 / 打车") });
      }
      const item = { ...base, activityType: activity.type, crowd: crowdRiskForVisit(base.crowd, activity.startTime, weather.date, weather), startTime: activity.startTime, endTime: activity.endTime, durationMin: activity.durationMin, recommendationReason: activity.reason, evidenceRefs: activity.evidenceRefs, alternativeSpotIds: activity.alternativeSpotIds, adjustmentCondition: activity.adjustmentCondition };
      if (item.factObservations?.crowd?.length && item.crowd?.score != null) {
        item.factObservations = { ...item.factObservations, crowd: item.factObservations.crowd.map((observation: any, index: number) => index ? observation : { ...observation, value: { ...observation.value, score: item.crowd.score, probability: item.crowd.riskProbability, label: item.crowd.label, factors: item.crowd.factors, factorContributions: item.crowd.factorContributions, forecastBand: item.crowd.forecastBand, confidenceLabel: item.crowd.confidenceLabel, evidenceCoverage: item.crowd.evidenceCoverage, recommendedWindow: item.crowd.recommendedWindow, recommendedWindows: item.crowd.recommendedWindows, avoidWindow: item.crowd.avoidWindow, peakWindow: item.crowd.peakWindow, action: item.crowd.action, visitTime: item.crowd.visitTime, visitDate: item.crowd.visitDate, modelVersion: item.crowd.modelVersion, officialRealtime: false } }) };
      }
      items.push(item);
      if (activity.type === "meal") {
        const dinner = /晚餐/.test(activity.label || "") || timeToMinutes(activity.startTime, 0) >= 17 * 60;
        blocks.push({ type: "rest", mealType: dinner ? "dinner" : "lunch", anchor: { lat: item.lat, lng: item.lng }, item, label: activity.label || `${item.name}用餐`, startTime: item.startTime, endTime: item.endTime, durationMin: item.durationMin, reason: activity.reason });
      } else blocks.push({ type: "attraction", item, startTime: item.startTime, endTime: item.endTime, durationMin: item.durationMin });
      previousSpot = item;
    } else {
      blocks.push({ type: "rest", mealType: activity.type === "meal" ? (/晚餐/.test(activity.label || "") ? "dinner" : "lunch") : undefined, label: activity.label || (activity.type === "meal" ? "用餐与休息" : "弹性休息"), startTime: activity.startTime, endTime: activity.endTime, durationMin: activity.durationMin, reason: activity.reason });
    }
  }
  return { day: dayIndex + 1, date: weather.date, weekday: weekday(weather.date), theme: dayDraft.theme || "城市探索", items, blocks, conflicts: [], weather, returnHotelTime: dayDraft.returnHotelTime, totalActivityMin: dayDraft.totalActivityMin, totalTransportMin: dayDraft.totalTransportMin };
}

async function monitorExecution(body: any, env: any) {
  const profile = body?.profile || {};
  const plan = body?.plan || {};
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const day = (plan.daysPlan || []).find((item: any) => item.date === today);
  if (!day) return { active: false, actionable: false, checkedAt: new Date().toISOString(), note: "当前日期不在该行程执行区间，未启动途中监控" };
  const nowMinute = timeToMinutes(time, 0);
  const remaining = (day.items || []).filter((item: any) => timeToMinutes(item.endTime, 1440) >= nowMinute).slice(0, 8);
  if (!remaining.length) return { active: true, actionable: false, checkedAt: new Date().toISOString(), note: "今日已没有待执行景点" };
  const city = await resolveCity(cleanText(profile.city || plan.city), env);
  const signalSpots = remaining.map((item: any, index: number) => ({ id: cleanText(item.id, `monitor-${index}`), name: cleanText(item.name) }));
  const [weather, signals] = await Promise.all([
    weatherFor(city, today, 1),
    publicTravelSignals(city, signalSpots),
  ]);
  const triggers: any[] = [];
  const todayWeather = weather.tripForecast?.[0];
  if (todayWeather?.quality === "forecast" && Number(todayWeather.precipitationProbability || 0) >= 70) triggers.push({ code: "HEAVY_RAIN", severity: "high", subject: today, reason: `今日最高降雨概率 ${todayWeather.precipitationProbability}%`, action: "将户外节点替换为候选池中的室内备选，并减少跨区移动" });
  for (const spot of signalSpots) {
    const signal = signals.bySpot?.get?.(spot.id);
    const alert = signal?.openingAlerts?.[0];
    if (alert) triggers.push({ code: "OPENING_ALERT", severity: "high", subject: spot.name, reason: `检测到近期开放状态公告：${cleanText(alert.title)}`, sourceUrl: alert.url || null, action: "暂停依赖原开放时间，改用同类备选并提示核对公告生效日期" });
  }
  const nextPair = remaining.slice(0, 2);
  if (nextPair.length === 2) {
    const currentTransit: any = await amapTransitFor(nextPair[0], nextPair[1], city, env);
    const plannedLeg = (day.blocks || []).find((block: any) => block.type === "leg" && block.from === nextPair[0].name && block.to === nextPair[1].name);
    if (currentTransit.status === "ready" && currentTransit.durationMin && plannedLeg?.durationMin && currentTransit.durationMin > Number(plannedLeg.durationMin) * 1.5 + 10) triggers.push({ code: "TRANSIT_DELAY", severity: "high", subject: `${nextPair[0].name} → ${nextPair[1].name}`, reason: `高德当前公交查询约 ${currentTransit.durationMin} 分钟，原计划 ${plannedLeg.durationMin} 分钟`, action: "推迟后续节点或切换更近备选，保留用餐和返程硬约束" });
  }
  const adjustment = triggers.length ? `执行监控在 ${today} ${time} 发现：${triggers.map((item) => `${item.subject}：${item.reason}`).join("；")}。请按最小扰动原则自动重规划今天剩余行程，保留已完成节点、必去硬约束、正常用餐和返程时间，并逐条解释调整原因。` : "";
  return {
    active: true, actionable: triggers.some((item) => item.severity === "high"), triggers, adjustment,
    eventKey: triggers.map((item) => `${item.code}:${item.subject}:${item.reason}`).join("|"),
    checkedAt: new Date().toISOString(), sources: { weather: weather.source, openingSignals: signals.provider, transit: "高德地图 MCP 当前公交查询" },
    note: triggers.length ? "已发现会影响可执行性的变化" : "本轮没有发现需要自动重规划的高风险变化",
  };
}

type PlanningProgressUpdate = (progress: any) => Promise<void>;

function liveProgress(profile: any, city: any, title: string, items: string[], sources: any[] = [], phase: "live" | "route" = "live") {
  return { phase, title, items, sources, formSync: profile, generatedAt: new Date().toISOString(), collapsible: true, city: city.name };
}

const SESSION_COOKIE = "smart_travel_session";
const WORKFLOW_STAGES = ["parse_profile", "collect_sources", "build_knowledge", "build_matrix", "planner_research", "planner_memo", "variant_hot", "variant_niche", "variant_relax", "audit_initial", "repair_round_1", "audit_round_1", "repair_round_2", "audit_final", "final_transit", "compile_result"];
const stageLabels: Record<string, string> = {
  parse_profile: "正在由 V4 Flash 正式理解需求", collect_sources: "正在并行获取天气、景点与住宿候选", build_knowledge: "正在核验必选实体、趋势、时令与拥挤风险", build_matrix: "正在建立透明交通候选矩阵", planner_research: "V4 Pro 正在联网核验关键资料", planner_memo: "V4 Pro 正在形成深度决策备忘录", variant_hot: "正在生成经典覆盖方案", variant_niche: "正在生成自然摄影方案", variant_relax: "正在生成轻松避峰方案", audit_initial: "正在执行第一轮硬约束审计", repair_round_1: "正在修复第一轮硬冲突", audit_round_1: "正在复核第一轮修复", repair_round_2: "正在进行最后一轮定向修复", audit_final: "正在执行最终硬约束审计", final_transit: "正在核验最终相邻交通段并重排时间", compile_result: "正在编译可信度与最终结果",
};

function cookieValue(request: Request, name: string): string {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

async function taskSession(request: Request, env: any, create = false) {
  let value = cookieValue(request, SESSION_COOKIE);
  let setCookie = "";
  if (!value && create) {
    value = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    setCookie = `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=86400; Path=/; Secure; HttpOnly; SameSite=Strict`;
  }
  const hash = value ? await sha256(`${cleanText(env?.RATE_LIMIT_SALT, "smart-travel-public")}|session|${value}`) : "";
  return { hash, setCookie };
}

function sanitizeReplanContext(input: any) {
  const replanInput = input?.replanContext;
  return replanInput && Array.isArray(replanInput.days) ? {
    adjustment: cleanText(replanInput.adjustment).slice(0, 800),
    activeVariant: ["relax", "hot", "niche"].includes(cleanText(replanInput.activeVariant)) ? cleanText(replanInput.activeVariant) : "relax",
    days: replanInput.days.slice(0, 7).map((day: any, index: number) => ({
      day: Number(day?.day || index + 1), spotIds: Array.isArray(day?.spotIds) ? day.spotIds.map((value: any) => cleanText(value)).filter(Boolean).slice(0, 5) : [],
      items: Array.isArray(day?.items) ? day.items.slice(0, 5).map((item: any) => ({ id: cleanText(item?.id), name: cleanText(item?.name), lat: Number.isFinite(Number(item?.lat)) ? Number(item.lat) : undefined, lng: Number.isFinite(Number(item?.lng)) ? Number(item.lng) : undefined, category: cleanText(item?.category), startTime: cleanText(item?.startTime), endTime: cleanText(item?.endTime), durationMin: clamp(item?.durationMin, 20, 360), openingHours: cleanText(item?.openingHours) || null, sourceName: cleanText(item?.sourceName), sourceUrl: cleanText(item?.sourceUrl) || null, fetchedAt: cleanText(item?.fetchedAt), requiredByUser: Boolean(item?.requiredByUser) })).filter((item: any) => item.id && item.name) : [],
    })),
  } : null;
}

async function progressForStage(jobId: string, stage: string, envelope: any, extra: string[] = []) {
  const completed = WORKFLOW_STAGES.indexOf(stage);
  const profile = envelope?.profile;
  const sources = await listJobProviderAttempts(jobId);
  return {
    phase: stage === "parse_profile" ? "analysis" : stage.startsWith("variant_") || stage.startsWith("audit_") || stage.startsWith("repair_") || stage === "final_transit" || stage === "compile_result" ? "route" : "live",
    title: stageLabels[stage] || "正在规划",
    items: [`✓ 已完成 ${Math.max(0, completed)}/${WORKFLOW_STAGES.length} 个持久阶段`, ...extra, `● 当前检查点：${stage}`],
    sources: sources.map((attempt, index) => ({ id: /天气/.test(attempt.capability) ? "weather" : /景点/.test(attempt.capability) ? "spots" : /住宿|酒店/.test(attempt.capability) ? "hotels" : /交通|矩阵/.test(attempt.capability) ? "routing" : /拥挤/.test(attempt.capability) ? "crowd" : /时令|趋势/.test(attempt.capability) ? "season" : `${attempt.capability}-${index}`, label: attempt.capability, provider: attempt.provider, state: attempt.status === "success" ? "success" : attempt.status === "failed" || attempt.status === "rate_limited" ? "error" : "unavailable", detail: [attempt.code, attempt.detail, attempt.resultCount == null ? "" : `${attempt.resultCount} 条`].filter(Boolean).join(" · ") })),
    formSync: profile, generatedAt: new Date().toISOString(), collapsible: true,
  };
}

async function runInternalPlanStage(jobId: string, stage: string, workflowId: string, env: any) {
  if (!WORKFLOW_STAGES.includes(stage)) throw new Error(`未知规划阶段：${stage}`);
  const job = await getTravelJob(jobId);
  if (!job) throw new Error("规划任务不存在");
  if (job.status === "cancelled" || job.cancelRequestedAt) return { cancelled: true };
  if (job.status === "done") return { done: true };
  if (Date.now() > job.expiresAt) {
    await updateTravelJob(jobId, { status: "error", errorCode: "JOB_EXPIRED", errorMessage: "规划任务已超过 24 小时恢复期限", completedAt: Date.now() });
    return { done: true, status: "error" };
  }
  if (await getTravelJobArtifact(jobId, `stage:${stage}`)) return { ok: true, skipped: true, stage };
  const owner = workflowId || `workflow-${jobId}`;
  const nonce = crypto.randomUUID();
  if (!await acquireTravelJobLease(jobId, owner, nonce)) throw new Error("任务阶段租约暂不可用");
  await updateTravelJob(jobId, { status: "working", workflowId: owner, currentStep: stage, heartbeatAt: Date.now(), progress: await progressForStage(jobId, stage, await getTravelJobArtifact(jobId, "envelope") || job.payload) });
  await addTravelJobEvent({ jobId, eventType: "stage_started", step: stage, message: stageLabels[stage] || stage, createdAt: Date.now() });
  const heartbeat = setInterval(() => { renewTravelJobLease(jobId, owner, nonce).catch(() => undefined); }, 15_000);
  const assertCommitAllowed = async () => {
    const current = await getTravelJob(jobId);
    if (!current || current.status === "cancelled" || current.cancelRequestedAt) throw new Error("TASK_CANCELLED");
    if (current.leaseOwner !== owner || current.leaseNonce !== nonce || Number(current.leaseExpiresAt || 0) < Date.now()) throw new Error("LEASE_LOST");
  };
  try {
    let envelope: any = await getTravelJobArtifact(jobId, "envelope");
    if (stage === "parse_profile") {
      const input = job.payload;
      const profile = await extractProfile(input, env);
      if (profile.clarificationNeeded) {
        await updateTravelJob(jobId, { status: "needs_input", currentStep: stage, progress: { phase: "analysis", title: "需要补充信息", items: [profile.clarificationQuestion || "请明确主要目的地"], formSync: profile } });
        return { done: true, status: "needs_input" };
      }
      const city = await resolveCity(profile.city, env);
      profile.city = city.name;
      envelope = { version: 4, createdAt: job.createdAt, profile, city, replanContext: sanitizeReplanContext(input) };
      await assertCommitAllowed();
      await putTravelJobArtifact(jobId, "envelope", envelope);
    } else if (!envelope) throw new Error("需求解析检查点缺失");

    if (stage === "collect_sources") {
      const existingPrepared = await getTravelJobArtifact(jobId, "prepared");
      if (!existingPrepared) {
        const started = Date.now();
        const prepared = await preparePlanKnowledge(envelope.profile, envelope.city, env);
        await assertCommitAllowed();
        await putTravelJobArtifact(jobId, "prepared", prepared);
        const branches = [
          { provider: prepared.weather?.mcpStatus === "ready" ? "MCPMarket 天气查询" : "Open-Meteo 直连兜底", capability: "天气", ok: prepared.providerBundle.weather.status === "ready", count: prepared.weather?.tripForecast?.length || 0, detail: prepared.weather?.mcpStatus === "fallback" ? `天气 MCP 失败：${prepared.weather?.mcpNote || "未返回"}；Open-Meteo 已兜底` : "天气 MCP 成功；Open-Meteo 补充日照时间" },
          { provider: "高德官方 / Wikimedia / OSM", capability: "景点", ok: prepared.providerBundle.spots.status === "ready", count: prepared.rawSpots?.length || 0, detail: prepared.providerBundle.spots.error },
          { provider: prepared.hotel?.candidates?.length ? "高德酒店 POI / 酒店 MCP" : "住宿数据源", capability: "住宿候选（非指定日期实时价格）", ok: prepared.providerBundle.hotels.status === "ready", count: prepared.hotel?.candidates?.length || 0, detail: `${prepared.hotel?.note || prepared.providerBundle.hotels.error || "候选已返回"}；指定日期房态、税费、房型、取消政策保持未知` },
        ];
        for (const branch of branches) await recordJobProviderAttempt(jobId, stage, { provider: branch.provider, capability: branch.capability, status: branch.ok ? "success" : "failed", detail: branch.detail || (branch.ok ? "本次任务已返回" : "本次任务未返回"), latencyMs: Date.now() - started, resultCount: branch.count });
      }
    }
    if (stage === "build_knowledge" || stage === "build_matrix") {
      const prepared: any = await getTravelJobArtifact(jobId, "prepared");
      if (!prepared) throw new Error("实时数据检查点缺失");
      await putTravelJobArtifact(jobId, stage === "build_knowledge" ? "knowledge_summary" : "matrix_summary", stage === "build_knowledge" ? { spotCount: prepared.plannerSpots?.length || 0, unknowns: prepared.knowledge?.unknowns || [], intelligence: prepared.knowledge?.intelligence } : { total: prepared.trafficMatrix?.legs?.length || 0, verified: prepared.trafficMatrix?.legs?.filter((leg: any) => leg.quality === "verified").length || 0, estimated: prepared.trafficMatrix?.legs?.filter((leg: any) => leg.quality !== "verified").length || 0, source: prepared.trafficMatrix?.source });
      if (stage === "build_knowledge") {
        const predictedCrowdSpots = prepared.plannerSpots?.filter((spot: any) => spot.crowdRisk?.score != null || spot.crowd?.score != null) || [];
        const averageCoverage = predictedCrowdSpots.length ? Math.round(predictedCrowdSpots.reduce((sum: number, spot: any) => sum + Number(spot.crowdRisk?.evidenceCoverage ?? spot.crowd?.evidenceCoverage ?? 0), 0) / predictedCrowdSpots.length) : 0;
        await recordJobProviderAttempt(jobId, stage, { provider: "Crowd Risk v2 多源风险模型", capability: "拥挤风险预测", status: predictedCrowdSpots.length ? "success" : "degraded", detail: `${predictedCrowdSpots.length} 个景点已生成预测；平均证据覆盖 ${averageCoverage}%；官方实时人数 0 项`, resultCount: predictedCrowdSpots.length });
        await recordJobProviderAttempt(jobId, stage, { provider: prepared.intelligence?.news?.provider || "公开趋势服务", capability: "热门与时令信号", status: prepared.intelligence?.news?.status === "ready" ? "success" : "degraded", detail: prepared.intelligence?.news?.error || "仅使用可归因公开报道", resultCount: prepared.intelligence?.news?.articles?.length || 0 });
      } else {
        const total = prepared.trafficMatrix?.legs?.length || 0;
        const verified = Number(prepared.trafficMatrix?.verifiedLegCount || 0);
        await recordJobProviderAttempt(jobId, stage, { provider: prepared.trafficMatrix?.source || "交通矩阵", capability: "候选交通矩阵", status: total ? "success" : "failed", detail: `高德核验 ${verified} 段 / 模型估算 ${Math.max(0, total - verified)} 段`, resultCount: total });
      }
    }
    if (stage === "planner_research" || stage === "planner_memo" || stage.startsWith("variant_") || stage.startsWith("audit_") || stage.startsWith("repair_")) {
      const prepared: any = await getTravelJobArtifact(jobId, "prepared");
      if (!prepared?.knowledge) throw new Error("规划知识包检查点缺失");
      const plannerState = await runPlannerWorkflowStage(stage, envelope.profile, prepared.knowledge, env, envelope.replanContext, await getTravelJobArtifact(jobId, "planner_state"), await getTravelJobArtifact(jobId, `attempt:${stage}`));
      await assertCommitAllowed();
      await putTravelJobArtifact(jobId, "planner_state", plannerState);
      if (stage.startsWith("variant_")) await putTravelJobArtifact(jobId, stage, plannerState.draft.variants.find((variant: any) => variant.id === stage.slice(8)));
    }
    if (stage === "final_transit") {
      const prepared: any = await getTravelJobArtifact(jobId, "prepared");
      const plannerState: any = await getTravelJobArtifact(jobId, "planner_state");
      if (!prepared || !plannerState?.audit || plannerState.audit.hardIssues?.length) throw new Error("最终审计检查点未通过");
      const result = await buildPlan(envelope.profile, envelope.city, env, envelope.replanContext, async (progress) => updateTravelJob(jobId, { status: "working", currentStep: stage, heartbeatAt: Date.now(), progress }), prepared, { draft: plannerState.draft, audit: plannerState.audit, modelAudit: plannerState.modelAudit });
      await assertCommitAllowed();
      await putTravelJobArtifact(jobId, "final_result", result);
    }
    if (stage === "compile_result") {
      const result = await getTravelJobArtifact(jobId, "final_result");
      if (!result) throw new Error("最终结果检查点缺失");
      assertPlanContract(result);
      await assertCommitAllowed();
      await updateTravelJob(jobId, { status: "done", currentStep: stage, heartbeatAt: Date.now(), result, progress: (result as any).progress, completedAt: Date.now() });
    }
    await assertCommitAllowed();
    await putTravelJobArtifact(jobId, `stage:${stage}`, { completedAt: new Date().toISOString(), workflowId: owner });
    await addTravelJobEvent({ jobId, eventType: "stage_completed", step: stage, message: `${stageLabels[stage] || stage}已完成`, createdAt: Date.now() });
    if (stage !== "compile_result") await updateTravelJob(jobId, { status: "working", currentStep: stage, heartbeatAt: Date.now(), progress: await progressForStage(jobId, stage, envelope) });
    return { ok: true, stage, done: stage === "compile_result" };
  } finally {
    clearInterval(heartbeat);
    await releaseTravelJobLease(jobId, owner, nonce);
  }
}

async function nextIncompleteStage(jobId: string): Promise<string | null> {
  for (const stage of WORKFLOW_STAGES) {
    if (!await getTravelJobArtifact(jobId, `stage:${stage}`)) return stage;
  }
  return null;
}

async function advancePlanningJob(jobId: string, env: any) {
  const job = await getTravelJob(jobId);
  if (!job) throw new Error("规划任务不存在");
  if (["done", "error", "cancelled", "needs_input"].includes(job.status)) return { status: job.status, progress: job.progress };
  const stage = await nextIncompleteStage(jobId);
  if (!stage) {
    if (job.result) await updateTravelJob(jobId, { status: "done", completedAt: job.completedAt || Date.now() });
    else await updateTravelJob(jobId, { status: "error", errorCode: "CHECKPOINT_INCOMPLETE", errorMessage: "所有阶段已结束，但最终结果检查点缺失", completedAt: Date.now() });
    const finished = await getTravelJob(jobId);
    return { status: finished?.status || "error", progress: finished?.progress };
  }
  try {
    const result = await runInternalPlanStage(jobId, stage, `site-runner-${crypto.randomUUID()}`, env);
    const current = await getTravelJob(jobId);
    return { ...result, status: current?.status || "working", progress: current?.progress, currentStep: current?.currentStep };
  } catch (error: any) {
    const message = cleanText(error?.message, "阶段执行失败");
    if (/租约暂不可用|LEASE_LOST/.test(message)) return { status: "working", retryable: true, retryAfterMs: 10_000, currentStep: stage };
    const attemptKey = `attempt:${stage}`;
    const previous: any = await getTravelJobArtifact(jobId, attemptKey);
    const attempts = Number(previous?.attempts || 0) + 1;
    const limit = stage.startsWith("variant_") || stage.startsWith("repair_") || stage === "planner_memo" ? 2 : 3;
    await putTravelJobArtifact(jobId, attemptKey, { attempts, lastError: message, updatedAt: new Date().toISOString() });
    if (attempts >= limit) {
      await updateTravelJob(jobId, { status: "error", currentStep: stage, attemptCount: Number(job.attemptCount || 0) + 1, errorCode: "STAGE_RETRY_EXHAUSTED", errorMessage: `${stageLabels[stage] || stage}连续失败 ${attempts} 次：${message}`, completedAt: Date.now() });
      await addTravelJobEvent({ jobId, eventType: "stage_failed", step: stage, message: `${stageLabels[stage] || stage}重试耗尽`, detail: { attempts, error: message }, createdAt: Date.now() });
      return { status: "error", currentStep: stage, retryable: false };
    }
    const envelope = await getTravelJobArtifact(jobId, "envelope") || job.payload;
    const progress = await progressForStage(jobId, stage, envelope, [`! 本阶段第 ${attempts} 次调用失败，将从检查点自动重试`, `! ${message}`]);
    await updateTravelJob(jobId, { status: "working", currentStep: stage, heartbeatAt: Date.now(), attemptCount: Number(job.attemptCount || 0) + 1, progress });
    await addTravelJobEvent({ jobId, eventType: "stage_retry", step: stage, message: `${stageLabels[stage] || stage}将在检查点重试`, detail: { attempts, limit, error: message }, createdAt: Date.now() });
    return { status: "working", currentStep: stage, retryable: true, retryAfterMs: Math.min(60_000, attempts * 10_000), progress };
  }
}

function rateLimitPolicy(pathname: string, method: string) {
  if (pathname === "/api/plan/start" && method === "POST") return { endpoint: "plan-start", limit: 6, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/plan/status") return { endpoint: "plan-status", limit: 3600, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/plan/active") return { endpoint: "plan-active", limit: 600, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/plan/advance") return { endpoint: "plan-advance", limit: 600, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/plan/cancel") return { endpoint: "plan-cancel", limit: 60, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/agent") return { endpoint: "agent", limit: 30, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/image") return { endpoint: "image", limit: 180, windowMs: 60 * 60 * 1000 };
  if (pathname === "/api/monitor") return { endpoint: "monitor", limit: 30, windowMs: 60 * 60 * 1000 };
  return { endpoint: "public-data", limit: 240, windowMs: 60 * 60 * 1000 };
}

export async function handleTravelApi(request: Request, env: any, url: URL, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response | null> {
  try {
    configurePersistence(env?.DB);
    const clientHash = await requestClientHash(request, cleanText(env?.RATE_LIMIT_SALT, "smart-travel-public"));
    const policy = rateLimitPolicy(url.pathname, request.method);
    const quota = await consumeRateLimit(clientHash, policy.endpoint, policy.limit, policy.windowMs);
    if (!quota.allowed) return json({ error: { message: `请求过于频繁，请在约 ${quota.retryAfterSeconds} 秒后重试`, code: "RATE_LIMITED", limit: quota.limit } }, 429, { "retry-after": String(quota.retryAfterSeconds) });

    if (url.pathname === "/api/health") {
      const [services, metrics] = await Promise.all([providerHealthSnapshot(), runtimeMetrics()]);
      return json({
      ok: true,
      ai: {
        status: aiApiKey(env) ? "configured" : "unconfigured",
        provider: "联通元景",
        model: aiPrimaryModel(env, "planner"),
        extractionModel: aiPrimaryModel(env, "extract"), plannerModel: aiPrimaryModel(env, "planner"), repairModel: aiPrimaryModel(env, "repair"),
        repairFallbackModel: aiModelCandidates(env, "repair")[1] || null,
        thinking: { planner: "user-controlled", repair: "on-conflict", reasoningContentExposed: false },
        network: { enabled: true, mode: "后端受控取证", tools: ["Wikimedia 公开检索", "高德地图 / MCP POI 查询", "国内公开热榜", "天气、酒店与交通数据源"] },
        note: "DeepSeek V4 Flash 负责文本优先的需求提取和陪聊；DeepSeek V4 Pro 负责联网取证后的三方案时间决策、冲突修复与重规划。GLM 已从模型路由中移除。",
      },
      services,
      metrics: { persistence: metrics.persistence, activeJobs: metrics.activeJobs, cacheEntries: metrics.cacheEntries, cacheHits: metrics.cacheHits, requests24h: metrics.requests24h },
      serviceStatusNote: services.length ? "状态来自最近一次真实请求，不代表永久可用" : "尚无真实调用记录，服务状态保持未知",
    });
    }

    if (url.pathname === "/api/providers/status") return json({
      providers: await providerHealthSnapshot(),
      metrics: await runtimeMetrics(),
      note: "只展示最近一次真实调用结果、耗时、429、失败与缓存命中；没有调用记录时不标记 ready。",
    });

    if (url.pathname === "/api/ops/metrics") return json(await runtimeMetrics());

    if (url.pathname === "/api/cities") {
      const centers = COMMON_CHINA_CITIES.map(([name, lat, lng]) => ({ name, displayName: `${name}，中国`, lat, lng, zoom: 11, countryCode: "cn", source: "内置城市入口坐标" }));
      return json({ cities: centers, scope: "中国", note: "仅为常用城市入口；任意中国城市仍通过搜索接口实时查找" });
    }

    if (url.pathname === "/api/city-search") return json({ cities: await searchCities(cleanText(url.searchParams.get("q")), 8, env), scope: "中国" });

    if (url.pathname === "/api/travel-signals") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"), env);
      const names = cleanText(url.searchParams.get("spots"), "西湖,灵隐寺").split(/[,，]/).map((name) => cleanText(name)).filter(Boolean).slice(0, 12);
      const spots = names.map((name, index) => ({ id: `signal-${index + 1}`, name }));
      const [signals, social] = await Promise.all([publicTravelSignals(city, spots), optionalSocialSignals(env, city, spots)]);
      return json({
        city: city.name, provider: signals.provider, status: signals.status, fetchedAt: signals.fetchedAt,
        articleCount: signals.articles?.length || 0,
        social: { provider: social.provider, status: social.status, fetchedAt: social.fetchedAt, detail: social.detail },
        spots: spots.map((spot) => ({ name: spot.name, socialMentions: Number(social.bySpot.get(spot.id) || 0), ...(signals.bySpot.get(spot.id) || { mentions: 0, domains: 0, articles: [], seasonal: [], openingAlerts: [] }) })),
        error: signals.error || null, fallbackError: signals.fallbackError || null,
      });
    }

    if (url.pathname === "/api/weather") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"), env);
      return json(await weatherFor(city, dateString(url.searchParams.get("startDate")), clamp(url.searchParams.get("days"), 1, 7)));
    }

    if (url.pathname === "/api/hotels") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"), env);
      const startDate = dateString(url.searchParams.get("startDate"), addDays(new Date().toISOString().slice(0, 10), 3));
      const nights = clamp(url.searchParams.get("nights"), 1, 7);
      return json(await hotelFor({
        startDate, nights, days: nights + 1, partySize: clamp(url.searchParams.get("partySize"), 1, 20),
        lodgingArea: cleanText(url.searchParams.get("area")), hotelPreference: cleanText(url.searchParams.get("preference"), "交通方便"),
      }, city, env));
    }

    if (url.pathname === "/api/dining") {
      const city = cleanText(url.searchParams.get("city"));
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      const mealType = cleanText(url.searchParams.get("meal"), "lunch");
      return json(await diningFor(city, lat, lng, mealType));
    }

    if (url.pathname === "/api/spots") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"), env);
      const spots = await wikipediaSpots(city, clamp(url.searchParams.get("limit"), 1, 50), [], [], env);
      return json({ city: city.name, adcode: city.adcode || null, spots, count: spots.length, source: "高德地图官方 POI 优先；中文维基百科与 OSM 仅作可追溯补充", fetchedAt: new Date().toISOString() });
    }

    if (url.pathname === "/api/image") {
      const imageUrl = cleanText(url.searchParams.get("image"));
      const wikipedia = cleanText(url.searchParams.get("wikipedia"));
      const name = cleanText(url.searchParams.get("name"));
      const cityName = cleanText(url.searchParams.get("city"));
      const officialName = cleanText(url.searchParams.get("officialName"), name);
      const poiId = cleanText(url.searchParams.get("poiId"));
      const targetLat = Number(url.searchParams.get("lat"));
      const targetLng = Number(url.searchParams.get("lng"));
      const excluded = new Set(cleanText(url.searchParams.get("exclude")).split(",").filter(Boolean));
      const imageCacheKey = JSON.stringify({ imageUrl, wikipedia, name, officialName, poiId, cityName, targetLat: Number.isFinite(targetLat) ? targetLat : null, targetLng: Number.isFinite(targetLng) ? targetLng : null, excluded: [...excluded].sort() });
      const cachedImage = await persistentCacheGet("spot-image-v29", imageCacheKey);
      if (cachedImage && typeof cachedImage === "object") return json(cachedImage);
      const imageResponse = async (value: any) => {
        await persistentCachePut("spot-image-v29", imageCacheKey, value, value?.found ? 7 * 24 * 60 * 60 * 1000 : 10 * 60 * 1000);
        return json(value);
      };
      const attempts: string[] = [];
      if (name && cityName && !excluded.has("amap-official")) {
        try {
          const official = await amapOfficialImage(env, officialName || name, cityName, poiId, Number.isFinite(targetLat) ? targetLat : undefined, Number.isFinite(targetLng) ? targetLng : undefined);
          if (official) return await imageResponse(official);
          attempts.push("高德官方未找到匹配照片");
        } catch (error: any) { attempts.push(`高德官方：${cleanText(error?.message, "不可用")}`); }
      }
      if (!excluded.has("wikimedia")) {
        try {
          const parsed = new URL(imageUrl);
          if (parsed.protocol === "https:" && parsed.hostname.endsWith(".wikimedia.org")) {
            const title = wikipedia.replace(/^zh:/, "");
            return await imageResponse({ found: true, url: imageUrl, source: "Wikimedia 精确页面图片", provider: "wikimedia", sourceUrl: title ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : "https://commons.wikimedia.org/" });
          }
        } catch { /* no verified image */ }
      }
      let wikiEntity: any = null;
      if (name && cityName) {
        try {
          wikiEntity = await wikipediaExactEntity(name, cityName);
          if (!excluded.has("wikimedia") && wikiEntity?.found) return await imageResponse(wikiEntity);
          attempts.push("中文维基百科精确页面无图片");
        } catch (error: any) { attempts.push(`中文维基百科：${cleanText(error?.message, "不可用")}`); }
      }
      if (name && cityName && !excluded.has("unsplash")) {
        try {
          const unsplash = await unsplashImage(env, name, cityName, wikiEntity?.englishName || "");
          if (unsplash) return await imageResponse(unsplash);
          attempts.push("Unsplash 未找到相关照片");
        } catch (error: any) { attempts.push(`Unsplash：${cleanText(error?.message, "不可用")}`); }
      }
      if (name && cityName && !excluded.has("amap-mcp")) {
        try {
          const amap = await amapPoiForSpot(name, cityName);
          if (amap?.photo) return await imageResponse({
            found: true, url: amap.photo, source: "高德地图 POI 精确照片", provider: "amap-mcp",
            sourceUrl: amap.id ? `https://www.amap.com/place/${encodeURIComponent(amap.id)}` : "https://www.amap.com/",
            verifiedName: amap.name,
          });
          attempts.push("高德 MCP 未找到匹配照片");
        } catch (error: any) { attempts.push(`高德 MCP：${cleanText(error?.message, "不可用")}`); }
      }
      return await imageResponse({ found: false, reason: "高德、中文维基百科与 Unsplash 均未找到可验证图片；不使用无关猜图", attempts });
    }

    if (url.pathname === "/api/agent" && request.method === "POST") {
      const body = await request.json();
      const answer = await aiRequest(env, {
        purpose: "explain",
        thinking: false,
        maxTokens: 1800,
        webTools: { city: cleanText(body.context?.request?.city) },
        messages: [
        { role: "system", content: "你是旅行行程解释与咨询助手。优先依据用户提供的已核验上下文回答；需要核验新的景点实体、季节背景或位置时可调用联网工具。凡实时客流、预约、房价、开放状态等上下文或工具中为未知的内容，必须明确说未知，不得推测。回答简洁、中文。" },
        { role: "user", content: `问题：${cleanText(body.prompt)}\n已核验上下文：${JSON.stringify(body.context || {})}` },
        ],
      });
      return json({ message: answer.content, model: answer.model, networkToolCalls: answer.toolLog });
    }

    if (url.pathname === "/api/monitor" && request.method === "POST") return json(await monitorExecution(await request.json(), env));

    if (url.pathname === "/api/plan/start" && request.method === "POST") {
      const session = await taskSession(request, env, true);
      const existingActive = await findActiveTravelJob(session.hash);
      if (existingActive) return json({ error: { message: "您已有一个规划任务正在执行，可重新连接或先取消", code: "CONCURRENT_JOB_LIMIT", jobId: existingActive.id } }, 409, { "set-cookie": session.setCookie, "cache-control": "no-store" });
      const globalJobs = await activeJobCount();
      if (globalJobs >= 4) return json({ error: { message: "当前规划队列繁忙，请稍后再试", code: "GLOBAL_CONCURRENCY_LIMIT" } }, 503, { "retry-after": "20" });
      const dailyQuota = await consumeRateLimit("global", "plan-daily", clamp(env?.DAILY_PLAN_QUOTA || 100, 20, 1000), 24 * 60 * 60 * 1000);
      if (!dailyQuota.allowed) return json({ error: { message: "今日公开规划额度已用完，请明日再试", code: "DAILY_QUOTA_EXCEEDED" } }, 429, { "retry-after": String(dailyQuota.retryAfterSeconds) });
      const input = await request.json();
      const idempotencyKey = cleanText(request.headers.get("x-idempotency-key"));
      if (idempotencyKey.length < 16) return json({ error: { message: "缺少幂等请求标识，请刷新页面后重试", code: "IDEMPOTENCY_KEY_REQUIRED" } }, 400, { "set-cookie": session.setCookie });
      const jobId = crypto.randomUUID();
      const progress = { phase: "queued", title: "规划任务已建立断点", items: ["● 正在启动第一阶段", "● 刷新或断网不会丢失进度；重新打开后自动续跑", "● 完全关闭页面时任务暂停，不会继续消耗模型额度"], generatedAt: new Date().toISOString() };
      const now = Date.now();
      const created = await createTravelJob({
        id: jobId, idempotencyKey, clientHash, accessTokenHash: "", status: "queued", payload: input,
        progress, result: null, errorMessage: null, createdAt: now, updatedAt: now, expiresAt: now + 24 * 60 * 60 * 1000,
        workflowId: null, engineVersion: "v29-sites-checkpoint", currentStep: "queued", heartbeatAt: now, leaseOwner: null, leaseNonce: null, leaseExpiresAt: null, cancelRequestedAt: null, attemptCount: 0, errorCode: null, completedAt: null, sessionHash: session.hash,
      });
      if (created.created) {
        await updateTravelJob(jobId, { status: "queued", workflowId: "sites-checkpoint-runner", currentStep: "queued", heartbeatAt: Date.now() });
        await addTravelJobEvent({ jobId, eventType: "job_queued", step: "queued", message: "站内断点执行器已就绪；刷新或断网后可从最后检查点续跑", detail: { runner: "sites-checkpoint-v29" }, createdAt: Date.now() });
      }
      return json({ jobId: created.job.id, status: "queued", progress: created.job.progress || progress, engineVersion: "v29-sites-checkpoint" }, 202, { "set-cookie": session.setCookie, "cache-control": "no-store" });
    }

    if (url.pathname === "/api/plan/advance" && request.method === "POST") {
      const session = await taskSession(request, env);
      const body = await request.json().catch(() => ({}));
      const id = cleanText(body.jobId);
      if (!id || !session.hash) return json({ error: { message: "缺少任务或会话" } }, 400);
      const job = await getTravelJob(id);
      if (!job || job.sessionHash !== session.hash) return json({ error: { message: "任务不存在或无权访问" } }, 404);
      return json(await advancePlanningJob(id, env), 202, { "cache-control": "no-store" });
    }

    if (url.pathname === "/api/plan/status") {
      const id = cleanText(url.searchParams.get("id"));
      if (!id) return json({ error: { message: "缺少规划任务 ID" } }, 400);
      const session = await taskSession(request, env);
      if (!session.hash) return json({ error: { message: "任务会话已失效", code: "JOB_SESSION_REQUIRED" } }, 401);
      const job = await getTravelJob(id);
      if (!job) return json({ status: "error", error: { message: "规划任务不存在或已清理" } }, 404);
      if (job.sessionHash !== session.hash) return json({ status: "error", error: { message: "无权访问该规划任务" } }, 403);
      if (Date.now() > job.expiresAt) return json({ status: "error", error: { message: "规划任务已过期，请重新生成" } }, 410);
      const [events, providerAttempts] = await Promise.all([listTravelJobEvents(id), listJobProviderAttempts(id)]);
      const common = { jobId: id, status: job.status, progress: job.progress, currentStep: job.currentStep, heartbeatAt: job.heartbeatAt ? new Date(job.heartbeatAt).toISOString() : null, events, providerAttempts, engineVersion: job.engineVersion };
      if (job.status === "done" && job.result) return json({ ...common, result: job.result }, 200, { "cache-control": "no-store" });
      if (job.status === "error") return json({ ...common, error: { message: job.errorMessage || "规划任务执行失败", code: job.errorCode } }, 200, { "cache-control": "no-store" });
      if (job.status === "cancelled") return json({ ...common, error: { message: "规划任务已取消", code: "USER_CANCELLED" } }, 200, { "cache-control": "no-store" });
      return json(common, 200, { "cache-control": "no-store", "retry-after": "2" });
    }

    if (url.pathname === "/api/plan/active" && request.method === "GET") {
      const session = await taskSession(request, env);
      if (!session.hash) return json({ active: false }, 200, { "cache-control": "no-store" });
      const job = await findActiveTravelJob(session.hash);
      return json(job ? { active: true, jobId: job.id, status: job.status, progress: job.progress, currentStep: job.currentStep, heartbeatAt: job.heartbeatAt ? new Date(job.heartbeatAt).toISOString() : null, createdAt: new Date(job.createdAt).toISOString() } : { active: false }, 200, { "cache-control": "no-store" });
    }

    if (url.pathname === "/api/plan/cancel" && request.method === "POST") {
      const session = await taskSession(request, env);
      const body = await request.json().catch(() => ({}));
      const id = cleanText(body.jobId);
      if (!id || !session.hash) return json({ error: { message: "缺少任务或会话" } }, 400);
      const job = await getTravelJob(id);
      if (!job || job.sessionHash !== session.hash) return json({ error: { message: "任务不存在或无权访问" } }, 404);
      const cancelled = await requestTravelJobCancellation(id, session.hash);
      if (cancelled) {
        await addTravelJobEvent({ jobId: id, eventType: "job_cancelled", step: job.currentStep, message: "用户已取消规划；正在执行的阶段租约禁止继续提交", createdAt: Date.now() });
      }
      return json({ cancelled, jobId: id, status: cancelled ? "cancelled" : job.status }, 200, { "cache-control": "no-store" });
    }

    return null;
  } catch (error: any) {
    return json({ error: { message: cleanText(error?.message, "服务暂时不可用") } }, 500);
  }
}

async function preparePlanKnowledge(profile: any, city: any, env: any, report?: PlanningProgressUpdate) {
  const providerBundle = await settleTravelProviders({
    weather: weatherFor(city, profile.startDate, profile.days),
    spots: wikipediaSpots(city, 48, profile.requiredAttractions, profile.preferences, env),
    hotels: hotelFor(profile, city, env),
  });
  await report?.(liveProgress(profile, city, "基础数据查询已完成，正在核验候选实体……", [
    `${providerBundle.spots.status === "ready" ? "✓" : "!"} 景点候选：${providerBundle.spots.status === "ready" ? "已真实返回" : cleanText(providerBundle.spots.error, "未返回")}`,
    `${providerBundle.weather.status === "ready" ? "✓" : "!"} 天气预报：${providerBundle.weather.status === "ready" ? "已真实返回" : cleanText(providerBundle.weather.error, "未返回")}`,
    `${providerBundle.hotels.status === "ready" ? "✓" : "!"} 酒店候选：${providerBundle.hotels.status === "ready" ? "已真实返回" : cleanText(providerBundle.hotels.error, "未返回")}`,
    "● 正在进行必选景点实体消歧、父子景区去重和公开状态核验",
  ], [
    { id: "spots", label: "景点实体与常规开放信息", provider: providerBundle.spots.status === "ready" ? "Wikimedia / 高德 / OSM" : "未返回", state: providerBundle.spots.status === "ready" ? "success" : "error", detail: providerBundle.spots.error },
    { id: "weather", label: "天气预报", provider: providerBundle.weather.status === "ready" ? "天气服务已返回" : "未返回", state: providerBundle.weather.status === "ready" ? "success" : "error", detail: providerBundle.weather.error },
    { id: "routing", label: "公共交通矩阵", provider: "候选核验后开始", state: "waiting" },
    { id: "hotels", label: "住宿候选与参考价", provider: providerBundle.hotels.status === "ready" ? "高德 / 酒店 MCP" : "未返回", state: providerBundle.hotels.status === "ready" ? "success" : "unavailable", detail: providerBundle.hotels.error },
    { id: "crowd", label: "拥挤风险预测", provider: "等待趋势和天气输入", state: "waiting" },
    { id: "season", label: "近期趋势与时令报道信号", provider: "等待候选实体", state: "loading" },
  ]));
  const weather = providerBundle.weather.status === "ready"
    ? providerBundle.weather.data as any
    : {
      city: city.name, source: "Unavailable", fetchedAt: new Date().toISOString(),
      tripForecast: Array.from({ length: profile.days }, (_, index) => ({ date: addDays(profile.startDate, index), quality: "unavailable", note: `天气服务不可用：${providerBundle.weather.error || "Unknown"}` })),
    };
  const hotel = providerBundle.hotels.status === "ready"
    ? providerBundle.hotels.data as any
    : { name: cleanText(profile.lodgingArea, `${city.name}住宿区域`), candidates: [], pricedCount: 0, mcpStatus: "unavailable", note: `酒店查询不可用：${providerBundle.hotels.error || "Unknown"}；未生成假价格` };
  let rawSpots = providerBundle.spots.status === "ready" ? providerBundle.spots.data as any[] : [];
  const required = await verifyRequired(city, profile.requiredAttractions, rawSpots, env);
  const requiredNameById = new Map(required.map((spot: any, index: number) => [spot.id, profile.requiredAttractions[index] || spot.name]));
  rawSpots = uniqueSpots([...required, ...rawSpots]);

  const requiredNames = profile.requiredAttractions.map((name: string) => normalizeName(name));
  const excludedNames = (profile.excludedAttractions || []).map((name: string) => normalizeName(name));
  const canonicalRequiredIds = new Set(required.map((spot: any) => spot.id));
  const relatedRequired = (spot: any) => requiredNames.some((wanted: string) => {
    const actual = normalizeName(spot.name);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
  const filtered = rawSpots.filter((spot: any) => {
    if (!spot?.id || !spot?.name || !Number.isFinite(Number(spot.lat)) || !Number.isFinite(Number(spot.lng))) return false;
    if (excludedNames.some((excluded: string) => normalizeName(spot.name).includes(excluded))) return false;
    const entityText = `${spot.name || ""} ${spot.category || ""} ${spot.poiType || ""} ${spot.type || ""}`;
    if (isExcludedCandidatePoi(spot.name, entityText, canonicalRequiredIds.has(spot.id))) return false;
    if (/商务住宅|购物服务|公司企业|汽车服务|生活服务|医疗保健|大型商场/.test(entityText)) return false;
    if (/片场|摄影棚|摄影基地|总店|旗舰店|购物中心|商场|售楼处|影楼/.test(spot.name)) return false;
    if (/(?:北馆|南馆|东馆|西馆|分馆)$/.test(spot.name) && rawSpots.some((candidate: any) => normalizeName(candidate.name) === normalizeName(spot.name.replace(/(?:北馆|南馆|东馆|西馆|分馆)$/, "")))) return false;
    if (spot.category === "城市景观" && !/风景名胜|公园广场|科教文化|文物古迹|自然地名|特色街区|旅游景点|景区|公园|博物馆|美术馆|纪念馆|故居|遗址|古镇|寺|庙|塔|湖|山|湿地|运河|古街|历史|文化/.test(entityText)) return false;
    if (/暂停开放|永久关闭|停止营业/.test(`${spot.openingHours || ""} ${spot.status || ""}`)) return false;
    if (relatedRequired(spot) && !canonicalRequiredIds.has(spot.id)) return false;
    return true;
  });
  const preRanked = rankSpots(uniqueSpots([...required, ...filtered]), profile);
  const intelligence = await enrichTravelIntelligence(preRanked, profile, city, weather, env);
  const ranked = rankSpots(intelligence.spots, profile);
  if (ranked.length < Math.max(profile.days + required.length, 6)) throw new Error(`仅核验到 ${ranked.length} 个有效景点，无法可靠生成 ${profile.days} 天行程`);

  const trafficMatrix = await buildTrafficMatrix(profile, city, ranked, env);
  const matrixSpotIds = new Set(trafficMatrix.nodes.filter((node: any) => node.id !== "hotel").map((node: any) => node.id));
  const spots = ranked.filter((spot: any) => matrixSpotIds.has(spot.id)).map((spot: any) => requiredNameById.has(spot.id)
    ? { ...spot, name: requiredNameById.get(spot.id), requiredByUser: true, category: "用户必选" }
    : { ...spot, requiredByUser: false });
  const fetchedAt = new Date().toISOString();
  const plannerSpots = spots.map((spot: any) => {
    const canonicalName = cleanText(requiredNameById.get(spot.id), spot.name);
    const tags = [...new Set([spot.category, ...(spot.matchedPreferences || []), ...(/夜|江|湖|河|桥/.test(canonicalName) ? ["夜景"] : []), ...(/园|湖|山|湿地|溪|谷/.test(canonicalName) ? ["自然", "摄影"] : []), ...(/寺|庙|博物馆|遗址|故居|古镇/.test(canonicalName) ? ["文化"] : [])].map((value) => cleanText(value)).filter(Boolean))];
    const semantics = visitSemantics({ ...spot, name: canonicalName }, weather.tripForecast);
    return {
      id: spot.id, name: canonicalName, officialName: spot.officialName || spot.name, aliases: imageLookupNames(canonicalName, city.name), lat: Number(spot.lat), lng: Number(spot.lng),
      category: spot.category, poiType: spot.category || "旅游景点", cluster: cleanText(spot.district || spot.address, "Unknown"),
      recommendedDurationMin: clamp(spot.durationMin || 120, 60, 240), openingHours: spot.openingHours || null,
      openingStatus: spot.openingStatus?.status || (spot.openingHours ? "estimated" : "unknown"), openingAlert: spot.openingStatus?.alert || null,
      reservation: {
        relevant: Boolean(spot.requiredByUser || /博物馆|美术馆|纪念馆|故宫|寺|塔|乐园|动物园|海洋馆|演出|展览/.test(`${canonicalName}${spot.category || ""}`)),
        status: "unknown",
        note: "未接入景区指定日期官方预约余量",
      },
      officialVerification: officialVerificationFor(spot, city.name),
      indoor: /博物馆|展览|纪念馆|美术馆/.test(`${spot.name}${spot.category}`) ? true : /山|湖|园|湿地|古镇|街/.test(`${spot.name}${spot.category}`) ? false : null,
      weatherFit: /博物馆|展览|纪念馆|美术馆/.test(`${spot.name}${spot.category}`) ? ["降雨备选"] : ["无强降雨时优先"],
      bestTimes: semantics.preferredWindows,
      timeRole: semantics.role, preferredWindows: semantics.preferredWindows, avoidWindows: semantics.avoidWindows, timeRationale: semantics.rationale,
      seasonFit: spot.seasonality?.score != null
        ? { status: "predicted", score: spot.seasonality.score, state: spot.seasonality.state, note: spot.seasonality.label, source: spot.seasonality.source, sourceUrl: spot.seasonality.sourceUrl }
        : { status: "unknown", note: profile.seasonalNeeds?.length ? `用户关注 ${profile.seasonalNeeds.join("、")}；尚无指定日期时令实况证据` : "未取得指定日期时令实况证据" },
      hotness: spot.hotness,
      crowdRisk: spot.crowd,
      tags, requiredByUser: Boolean(spot.requiredByUser), sourceName: spot.sourceName || spot.source || "公开地图 / 中文维基百科",
      sourceUrl: spot.sourceUrl || null, fetchedAt: spot.fetchedAt || fetchedAt,
      sources: [{ name: spot.sourceName || spot.source || "公开地图 / 中文维基百科", url: spot.sourceUrl || null, fetchedAt: spot.fetchedAt || fetchedAt, status: spot.openingHours ? "entity-verified" : "entity-only" }],
      unknown: [!spot.openingHours ? "开放时间" : null, (spot.requiredByUser || /博物馆|美术馆|纪念馆|故宫|寺|塔|乐园|动物园|海洋馆|演出|展览/.test(`${canonicalName}${spot.category || ""}`)) ? "指定日期预约" : null, "官方实时客流"].filter(Boolean),
    };
  });
  const knowledge = {
    profile: { ...profile, freeText: undefined, extractionModel: undefined }, city,
    spots: plannerSpots,
    weather: weather.tripForecast,
    hotel,
    trafficMatrix,
    unknowns: [
      "官方实时客流（未接入，不能标记 Verified）",
      "景区指定日期预约余量",
      ...(weather.tripForecast.some((day: any) => day.quality === "unavailable") ? ["超出预报窗口的逐日天气"] : []),
      ...(!hotel.pricedCount ? ["指定日期酒店成交价与余房"] : []),
    ],
    dataPolicy: { verified: "仅来自工具返回", prediction: "必须显示 Prediction、概率、依据与不确定性", unknown: "不得升级为 Verified", crowd: "预测拥挤概率，不生成实时人数", trends: "Hotness 与 Seasonality 分离" },
    intelligence: { news: { status: intelligence.news.status, provider: intelligence.news.provider, fetchedAt: intelligence.news.fetchedAt, articleCount: intelligence.news.articles?.length || 0 }, social: { status: intelligence.social.status, provider: intelligence.social.provider, fetchedAt: intelligence.social.fetchedAt, detail: intelligence.social.detail } },
  };
  return {
    providerBundle, weather, hotel, rawSpots, required,
    requiredNameEntries: [...requiredNameById.entries()],
    intelligence: {
      news: { status: intelligence.news.status, provider: intelligence.news.provider, fetchedAt: intelligence.news.fetchedAt, articles: intelligence.news.articles || [], error: intelligence.news.error || null },
      social: { status: intelligence.social.status, provider: intelligence.social.provider, fetchedAt: intelligence.social.fetchedAt, detail: intelligence.social.detail, error: intelligence.social.error || null },
    },
    ranked, trafficMatrix, spots, fetchedAt, plannerSpots, knowledge,
  };
}

async function buildPlan(profile: any, city: any, env: any, replanContext: any = null, report?: PlanningProgressUpdate, preparedInput?: any, generatedInput?: any) {
  const prepared = preparedInput || await preparePlanKnowledge(profile, city, env, report);
  const { providerBundle, weather, hotel, rawSpots, required, intelligence, ranked, trafficMatrix, spots, fetchedAt, plannerSpots, knowledge } = prepared;
  const requiredNameById = new Map(prepared.requiredNameEntries || []);
  await report?.(liveProgress(profile, city, "公共交通矩阵已建立，V4 Pro 正在生成三套方案……", [
    `✓ 候选景点知识包：${plannerSpots.length} 个实体`,
    `✓ 规划前交通矩阵：${trafficMatrix.legs.length} 条路线`,
    `✓ 矩阵来源：${trafficMatrix.source}`,
    `● ${aiPrimaryModel(env, "planner")} 正在依据开放规则、天气预报、交通时间、饭点和夜景语义生成方案`,
  ], [
    { id: "spots", label: "景点实体与常规开放信息", provider: "Wikimedia / 高德 / OSM", state: "success", detail: `${plannerSpots.length} 个进入知识包` },
    { id: "weather", label: "天气预报", provider: weather.source || "未返回", state: providerBundle.weather.status === "ready" ? "success" : "error", detail: "来源已返回；数据性质仍为预报" },
    { id: "routing", label: "公共交通矩阵", provider: trafficMatrix.source, state: "success", detail: `${trafficMatrix.legs.length} 条路线` },
    { id: "hotels", label: "住宿候选与参考价", provider: hotel.candidates?.length ? "高德 / 酒店 MCP" : "未返回", state: hotel.candidates?.length ? "success" : "unavailable", detail: hotel.pricedCount ? `${hotel.pricedCount} 个带来源参考价，非成交价` : "无指定日期成交价" },
    { id: "crowd", label: "拥挤风险预测", provider: "Crowd Risk v2 多源风险模型", state: "success", detail: `${plannerSpots.filter((spot: any) => spot.crowdRisk?.score != null).length} 个景点有基础预测；显示区间、证据覆盖与置信度，不是实时人数` },
    { id: "season", label: "近期趋势与时令报道信号", provider: intelligence.news.status === "ready" ? intelligence.news.provider : "未返回", state: intelligence.news.status === "ready" ? "success" : "unavailable", detail: "仅使用可归因公开报道" },
  ], "route"));
  const generated = generatedInput || await generatePlannerDraft(profile, knowledge, env, replanContext);
  const plannerSpotById = new Map(plannerSpots.map((spot: any) => [spot.id, spot]));
  const spotsById = new Map(spots.map((spot: any) => {
    const plannerSpot: any = plannerSpotById.get(spot.id);
    const merged = { ...spot, reservation: plannerSpot?.reservation, officialVerification: plannerSpot?.officialVerification, timeRole: plannerSpot?.timeRole, preferredWindows: plannerSpot?.preferredWindows, avoidWindows: plannerSpot?.avoidWindows, timeRationale: plannerSpot?.timeRationale };
    return [spot.id, requiredNameById.has(spot.id) ? { ...merged, name: requiredNameById.get(spot.id), officialName: spot.officialName || spot.name } : merged];
  }));
  const alternatives: any[] = [];
  const finalTransitCache = new Map<string, Promise<any>>();
  const affectedDayIndexes = replanContext ? adjustmentDayIndexes(replanContext.adjustment, profile.days) : [];

  for (let variantIndex = 0; variantIndex < 3; variantIndex += 1) {
    const draftVariant = generated.draft.variants[variantIndex];
    const variantId = ["hot", "niche", "relax"][variantIndex];
    if (!draftVariant || draftVariant.days.length !== profile.days) throw new Error(`DeepSeek V4 Pro 返回的${variantId}方案天数不完整，已拒绝算法补齐`);
    let daysPlan = Array.from({ length: profile.days }, (_, dayIndex) => {
      const draftDay = draftVariant.days[dayIndex];
      return planDayFromDraft(draftDay, dayIndex, spotsById, trafficMatrix, weather.tripForecast[dayIndex], profile);
    });
    const missingRequired = required.filter((requiredSpot: any) => !daysPlan.flatMap((day: any) => day.items).some((item: any) => item.id === requiredSpot.id && normalizeName(item.name) === normalizeName(requiredNameById.get(requiredSpot.id) || requiredSpot.name) && item.requiredByUser));
    if (missingRequired.length) {
      throw new Error(`确定性编译器拒绝模型草案：${draftVariant?.title || variantId} 缺少 ${missingRequired.map((spot: any) => requiredNameById.get(spot.id) || spot.name).join("、")}`);
    }
    if (replanContext && variantId === replanContext.activeVariant && affectedDayIndexes.length) {
      daysPlan = daysPlan.map((day: any, dayIndex: number) => {
        if (affectedDayIndexes.includes(dayIndex)) return day;
        const previous = replanContext.days.find((item: any) => Number(item.day) === dayIndex + 1);
        if (!previous?.items?.length) return day;
        const preservedItems = previous.items.map((item: any) => spotsById.get(item.id) ? { ...spotsById.get(item.id), ...item } : item);
        const preservedBlocks = preservedItems.map((item: any) => ({ type: "attraction", item, startTime: item.startTime, endTime: item.endTime, durationMin: item.durationMin }));
        return { ...day, items: preservedItems, blocks: preservedBlocks, preserved: true };
      });
    }
    for (const day of daysPlan) {
      day.route = await routeFor(day.items);
      await enrichDayTransit(day, city, env, finalTransitCache);
      reflowDayAfterTransit(day, profile);
      day.dining = await Promise.all(day.blocks.filter((block: any) => block.type === "rest" && block.mealType && block.anchor).map((block: any) => diningFor(city.name, block.anchor.lat, block.anchor.lng, block.mealType)));
    }
    const transportEstimate = Math.round(daysPlan.reduce((sum: number, day: any) => sum + Number(day.route?.distance || 0), 0) / 1000 * 2.2);
    alternatives.push({
      id: variantId, city: city.name, cityRef: city, startDate: profile.startDate, days: profile.days, budget: profile.budget,
      style: draftVariant?.style || profile.style, preferences: profile.preferences, pace: profile.pace, variant: variantId, transport: profile.transport,
      title: draftVariant?.title || ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex], strategy: draftVariant?.strategy || "依据候选景点知识包与交通矩阵", weather,
      daysPlan, hotelPlan: hotel,
      budgetBreakdown: { knownEstimate: transportEstimate, limit: profile.budget, items: [{ name: "市内交通透明估算", amount: transportEstimate }, { name: "住宿（参考价不计入）", amount: null }, { name: "门票", amount: null }, { name: "餐饮", amount: null }], note: "仅汇总可用于决策的金额；酒店非指定日期参考价不纳入预算，缺失价格保持 Unknown" },
      dataSources: { weather: weather.source || "Unavailable", spots: "中文维基百科 / OSM / 高德 POI", hotels: hotel.candidates?.length ? "高德酒店 POI / 酒店 MCP" : "Unknown", routing: trafficMatrix.source, transit: "高德地图 MCP；不可用时保留 OSRM 矩阵事实", images: "高德官方 / Wikimedia / Unsplash", crowd: "Crowd Risk v2：日期/时段、景点承载特征、天气、公开趋势（非实时人数）", hotness: intelligence.news.status === "ready" ? intelligence.news.provider : "Unknown", seasonality: "近期公开报道中的时令实况信号；无证据则 Unknown", social: intelligence.social.status === "ready" ? intelligence.social.provider : "可选社交 MCP 未连接", reservations: "Unknown" },
      generatedAt: fetchedAt,
      planningDecision: { model: generated.modelAudit.plannerModel, repairModel: generated.modelAudit.repairModel, repairRounds: generated.modelAudit.repairRounds, formatRepairs: generated.modelAudit.formatRepairs, networkToolCalls: generated.modelAudit.toolCalls, degraded: generated.modelAudit.degraded, degradationReason: generated.modelAudit.degradationReason || null, draftCompilerIssues: generated.modelAudit.compilerIssues },
      changeScope: replanContext && variantId === replanContext.activeVariant ? { mode: affectedDayIndexes.length ? "minimum-disruption" : "global-with-preservation-guidance", affectedDays: affectedDayIndexes.map((index: number) => index + 1), preservedDays: Array.from({ length: profile.days }, (_, index) => index + 1).filter((day) => !affectedDayIndexes.includes(day - 1)), note: "未受影响日期的稳定景点 ID 与原时间由后端锁定，不交给模型重写。" } : null,
    });
  }

  for (const plan of alternatives) {
    plan.evaluation = planEvaluation(plan, profile, spots.length);
    plan.optimization = { algorithm: `${modelFamily(generated.modelAudit.plannerModel)} ${generated.modelAudit.deepReasoningUsed ? "深度决策" : "快速决策"} + 完整时间轴 + 规划前交通矩阵 + Travel Compiler`, candidateCount: spots.length, selectedCount: plan.evaluation.evidence.selectedCount, requiredCoverage: `${plan.evaluation.evidence.requiredMatched.length}/${plan.evaluation.evidence.requiredTotal}`, note: `交通矩阵在模型调用前生成；V4 Pro ${generated.modelAudit.deepReasoningUsed ? "先做限时深度约束推理，再" : "直接"}生成三套草案，经确定性校验，仅在硬冲突时进行局部修复。` };
    plan.candidatePool = spots.slice(0, 16).map((spot: any) => ({ id: spot.id, name: spot.name, category: spot.category, score: spot.plannerScore, scoreBreakdown: spot.scoreBreakdown, scoreBasis: spot.scoreBasis, requiredByUser: spot.requiredByUser, matchedPreferences: spot.matchedPreferences, selected: plan.daysPlan.some((day: any) => day.items.some((item: any) => item.id === spot.id)) }));
    Object.assign(plan, analyzePlanTrustV2(plan, profile));
    plan.changeSet = null;
    if (replanContext && plan.id === replanContext.activeVariant) {
      const previousDaysPlan = replanContext.days.map((previousDay: any) => ({ day: Number(previousDay.day), date: addDays(profile.startDate, Number(previousDay.day) - 1), items: previousDay.items || [], blocks: [] }));
      plan.changeSet = computeChangeSet({ ...plan, daysPlan: previousDaysPlan, changeSet: null }, plan, affectedDayIndexes.map((index: number) => index + 1));
    }
  }

  const requiredCoverage = alternatives.every((plan: any) => profile.requiredAttractions.every((name: string) => plan.daysPlan.flatMap((day: any) => day.items).some((item: any) => normalizeName(item.name) === normalizeName(name) && item.requiredByUser)));
  if (!requiredCoverage) {
    const details = alternatives.map((plan: any) => `${plan.id}=[${plan.daysPlan.flatMap((day: any) => day.items).filter((item: any) => item.requiredByUser).map((item: any) => `${item.id}:${item.name}`).join("、")}]`).join("；");
    throw new Error(`最终编译器拒绝返回：至少一套方案缺少用户必去景点；实际必去节点 ${details}`);
  }
  const transitLegs = alternatives.flatMap((plan: any) => plan.daysPlan).flatMap((day: any) => day.blocks).filter((block: any) => block.type === "leg");
  const uniqueTransitLegs = [...new Map(transitLegs.map((block: any) => [`${normalizeName(block.from)}->${normalizeName(block.to)}`, block])).values()] as any[];
  const amapVerifiedLegs = uniqueTransitLegs.filter((block: any) => block.mcpTransport).length;
  const candidateVerifiedLegs = Number(trafficMatrix.verifiedLegCount || 0);
  const candidateCoverageSummary = summarizeTrafficCoverage(trafficMatrix.legs.length, candidateVerifiedLegs);
  const finalCoverageSummary = summarizeTrafficCoverage(uniqueTransitLegs.length, amapVerifiedLegs);
  const candidateEstimatedLegs = candidateCoverageSummary.estimated;
  const candidateCoverage = candidateCoverageSummary.coveragePercent;
  const finalTransitCoverage = finalCoverageSummary.coveragePercent;
  for (const plan of alternatives) {
    plan.transportCoverage = {
      candidate: { total: trafficMatrix.legs.length, amapVerified: candidateVerifiedLegs, estimated: candidateEstimatedLegs, coveragePercent: candidateCoverage },
      final: { total: uniqueTransitLegs.length, amapVerified: amapVerifiedLegs, estimated: finalCoverageSummary.estimated, coveragePercent: finalTransitCoverage, status: finalCoverageSummary.status },
      note: finalTransitCoverage < 60 ? "最终行程高德核验覆盖率低于 60%，交通数据已标记降级" : "最终行程相邻段优先使用高德官方公交接口，高德 MCP 仅兜底",
    };
    if (finalTransitCoverage < 60) {
      plan.planningDecision.degraded = true;
      plan.planningDecision.degradationReason = [plan.planningDecision.degradationReason, "最终交通高德核验覆盖率低于 60%"].filter(Boolean).join("；");
    }
  }
  const progressItems = [
    `✓ 实际获取候选景点 ${rawSpots.length} 个，过滤后进入知识包 ${spots.length} 个`,
    `✓ 已核验用户必去景点 ${required.length} 个；三套方案均通过覆盖检查`,
    `✓ 候选交通矩阵：总计 ${trafficMatrix.legs.length} 段，高德核验 ${candidateVerifiedLegs} 段，模型估算 ${candidateEstimatedLegs} 段，覆盖率 ${candidateCoverage}%`,
    `✓ 天气状态：${providerBundle.weather.status === "ready" ? `由 ${weather.source} 返回` : "Unavailable，未套用其他日期"}`,
    `✓ 公开趋势：${intelligence.news.status === "ready" ? `${intelligence.news.articles?.length || 0} 条近 7 天公开报道进入 Hotness / Seasonality 取证` : `Unavailable（${intelligence.news.error || "未返回"}）`}`,
    `${intelligence.social.status === "ready" ? "✓" : "●"} 社交趋势：${intelligence.social.status === "ready" ? `${intelligence.social.provider} 已返回公开热榜数据` : "国内热榜不可用；可选小红书 MCP 未连接，未自动登录或绕过验证码"}`,
    `✓ 已为 ${spots.filter((spot: any) => spot.crowd?.score != null).length} 个候选生成拥挤风险区间；平均证据覆盖 ${spots.length ? Math.round(spots.reduce((sum: number, spot: any) => sum + Number(spot.crowd?.evidenceCoverage || 0), 0) / spots.length) : 0}%，官方实时人数 0 项`,
    `✓ 酒店状态：${hotel.candidates?.length ? `${hotel.candidates.length} 个候选，${hotel.pricedCount || 0} 个带来源参考价` : "Unknown，未生成假酒店或假价格"}`,
    `✓ ${generated.modelAudit.plannerModel} 已生成完整活动时间轴；联网查询工具实际调用 ${generated.modelAudit.toolCalls.length} 次`,
    `✓ Travel Compiler 检出 ${generated.modelAudit.compilerIssues.length} 项并执行 ${generated.modelAudit.repairRounds} 轮 AI 修复`,
    `${finalTransitCoverage >= 80 ? "✓" : "●"} 最终行程去重交通段：高德核验 ${amapVerifiedLegs} 段，估算 ${uniqueTransitLegs.length - amapVerifiedLegs} 段，覆盖率 ${finalTransitCoverage}%`,
    `✓ 三套方案差异检查：最大 Jaccard ${Number(generated.audit.differences.maxJaccard || 0).toFixed(2)}`,
    generated.modelAudit.degraded ? `● 当前为透明降级结果：${generated.modelAudit.degradationReason}` : "✓ 最终方案通过硬约束核验",
  ];
  const progress = {
    phase: "route",
    title: generated.modelAudit.degraded ? "规划已完成（已明确标注降级）" : "三套路线已通过最终检查",
    items: progressItems,
    sources: [
      { id: "spots", label: "景点与开放信息", provider: "中文维基百科 / 高德地图 / OSM", state: providerBundle.spots.status === "ready" ? "success" : "error", detail: providerBundle.spots.status === "ready" ? `${spots.length} 个进入候选池` : providerBundle.spots.error },
      { id: "weather", label: "天气", provider: weather.source || "未返回", state: providerBundle.weather.status === "ready" ? "success" : "error", detail: providerBundle.weather.status === "ready" ? "已按出行日期核验" : providerBundle.weather.error },
      { id: "routing", label: "路线与交通时间", provider: trafficMatrix.source, state: trafficMatrix.legs.length ? "success" : "error", detail: `候选 ${candidateVerifiedLegs}/${trafficMatrix.legs.length} 段高德核验；最终去重 ${amapVerifiedLegs}/${uniqueTransitLegs.length} 段高德核验` },
      { id: "hotels", label: "住宿候选", provider: hotel.candidates?.length ? "高德地图 / 酒店 MCP" : "未返回", state: hotel.candidates?.length ? "success" : "unavailable", detail: hotel.candidates?.length ? `${hotel.candidates.length} 个候选` : "没有可靠候选" },
      { id: "crowd", label: "拥挤与预约", provider: "Crowd Risk v2 多源风险模型", state: spots.some((spot: any) => spot.crowd?.score != null) ? "success" : "unavailable", detail: `基础预测 ${spots.filter((spot: any) => spot.crowd?.score != null).length}/${spots.length} 个；平均证据覆盖 ${spots.length ? Math.round(spots.reduce((sum: number, spot: any) => sum + Number(spot.crowd?.evidenceCoverage || 0), 0) / spots.length) : 0}%；官方实时人数与预约余量未接入` },
      { id: "season", label: "热门与时令", provider: intelligence.news.status === "ready" ? `${intelligence.news.provider}${intelligence.social.status === "ready" ? ` + ${intelligence.social.provider}` : ""}` : "公开趋势服务未返回", state: intelligence.news.status === "ready" ? "success" : "unavailable", detail: `${spots.filter((spot: any) => spot.hotness?.score != null).length} 个有趋势信号 · ${spots.filter((spot: any) => spot.seasonality?.score != null).length} 个有时令证据` },
    ],
    formSync: profile,
    collapsible: true,
    generatedAt: fetchedAt,
  };
  const alternativeComparison = alternatives.map((plan: any) => ({ id: plan.id, title: plan.title, reliability: plan.compiler?.reliability, fragility: plan.fragility?.score, informationCompleteness: plan.compiler?.informationCompleteness, minBufferMinutes: plan.compiler?.minBufferMinutes, selectedCount: plan.evaluation?.evidence?.selectedCount, transportMinutes: plan.evaluation?.evidence?.transportMinutes, unknownCount: plan.uncertainty?.count, verificationCount: plan.minimumVerification?.length, stressResilientCount: plan.stressTest?.resilientCount }));
  const activeId = replanContext?.activeVariant || "relax";
  const activePlan = alternatives.find((plan: any) => plan.id === activeId) || alternatives[0];
  const workspaceId = `travel-${cleanText(city.name).replace(/\s+/g, "-")}-${profile.startDate}`;
  const result = {
    request: profile, alternatives, alternativeComparison, activeId, generatedAt: fetchedAt,
    agentEvents: buildPlanningEvents(workspaceId, profile, activePlan),
    planner: {
      type: "yuanjing-dual-model-constraint-solver",
      provider: "联通元景",
      extractionModel: profile.extractionModel || aiPrimaryModel(env, "extract"),
      plannerModel: generated.modelAudit.plannerModel,
      repairModel: generated.modelAudit.repairModel,
      repairFallbackModel: aiModelCandidates(env, "repair")[1] || null,
        thinking: { planner: generated.modelAudit.deepReasoningUsed ? "enabled" : "disabled-by-user", repair: "on-conflict", hiddenReasoningExposed: false },
      network: {
        enabled: true,
        implementation: "DeepSeek function calls -> server-side Wikimedia / 高德核验；天气 / 酒店 / 交通由后端先行取证",
        actualToolCalls: generated.modelAudit.toolCalls,
      },
      trafficMatrix: { readyBeforePlanner: true, source: trafficMatrix.source, legCount: trafficMatrix.legs.length, verifiedLegCount: candidateVerifiedLegs, estimatedLegCount: candidateEstimatedLegs, coveragePercent: candidateCoverage, finalVerifiedLegCount: amapVerifiedLegs, finalLegCount: uniqueTransitLegs.length, finalCoveragePercent: finalTransitCoverage, fetchedAt: trafficMatrix.fetchedAt },
      repairRounds: generated.modelAudit.repairRounds,
      degraded: generated.modelAudit.degraded,
      stages: [
        `${profile.extractionModel || aiPrimaryModel(env, "extract")} 需求结构化`,
        "真实数据与后端联网取证",
        "规划前交通矩阵",
        `${generated.modelAudit.plannerModel} 联网核验与三方案时间轴`,
        "确定性编译",
        `${generated.modelAudit.repairModel} 局部修复`,
        "最终核验",
      ],
    },
    progress,
  };
  assertPlanContract(result);
  return result;
}
