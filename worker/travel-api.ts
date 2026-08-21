// @ts-nocheck

import { assertPlanContract } from "./domain/contract.ts";
import { buildPlanningEvents } from "./domain/agent.ts";
import { computeChangeSet } from "./domain/replan.ts";
import { analyzePlanTrustV2 } from "./domain/trust.ts";
import {
  assertPlannerContext,
  auditPlannerDraft,
  mergeDeterministicProfile,
  parseStrictJsonObject,
  preserveLockedDays,
  settleTravelProviders,
} from "./domain/planner-v4.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const OSRM = "https://router.project-osrm.org";
const WEATHER_MCP = "https://mcpmarket.cn/mcp/a5be23a7cc256930f8f3ccc6";
const HOTEL_MCP = "https://mcpmarket.cn/mcp/14d52a3200549c758f548f52";
const AMAP_MCP = "https://mcpmarket.cn/mcp/06cbbceb8f161926894c4584";
const COMMON_CHINA_CITIES = [
  ["北京", 39.9042, 116.4074], ["上海", 31.2304, 121.4737], ["广州", 23.1291, 113.2644],
  ["深圳", 22.5431, 114.0579], ["杭州", 30.2741, 120.1551], ["成都", 30.5728, 104.0668],
  ["重庆", 29.563, 106.5516], ["西安", 34.3416, 108.9398], ["南京", 32.0603, 118.7969],
  ["苏州", 31.2989, 120.5853], ["厦门", 24.4798, 118.0894], ["昆明", 25.0389, 102.7183],
] as const;
const mcpMemory = new Map<string, { expiresAt: number; value: any }>();
const unsplashMemory = new Map<string, { expiresAt: number; value: any }>();

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

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 18000, source = "上游服务") {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, fetchOptions({ ...init, signal: controller.signal }));
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : {};
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 900 * (attempt + 1)));
        continue;
      }
      let detail = "";
      try { detail = cleanText(JSON.parse(text)?.error?.message || JSON.parse(text)?.reason); } catch { detail = cleanText(text).slice(0, 160); }
      if (response.status === 429) throw new Error(`${source}请求过于频繁（429）${detail ? `：${detail}` : "，请稍后重试"}`);
      throw new Error(`${source}返回 ${response.status}${detail ? `：${detail}` : ""}`);
    } catch (error: any) {
      if (error?.name === "AbortError") throw new Error(`${source}响应超时`);
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
  const cached = mcpMemory.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const timeoutMs = options.timeoutMs || 12000;
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
  mcpMemory.set(key, { expiresAt: Date.now() + (options.cacheMs || 5 * 60 * 1000), value });
  return value;
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
  return [...new Set(values.map(cleanText).filter(Boolean))];
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

function poiImageScore(poi: any, wantedNames: string[]) {
  const match = poiMatchScore(poi?.name, wantedNames);
  if (!match) return 0;
  const type = cleanText(poi?.type || poi?.typeName || poi?.category);
  if (/商务住宅|公司企业|餐饮服务|政府机构|医疗保健|汽车服务|生活服务/.test(type)) return 0;
  if (/风景名胜|公园广场|科教文化服务|特色商业街|自然地名|文物古迹/.test(type)) return match + 25;
  return match === 100 ? match : 0;
}

function parseJsonObject(text: string) {
  return parseStrictJsonObject(text);
}

function deepSeekModel(env: any, purpose: "extract" | "planner" | "repair" | "explain") {
  if (purpose === "extract") return cleanText(env.DEEPSEEK_EXTRACT_MODEL, "deepseek-v4-flash");
  if (purpose === "repair") return cleanText(env.DEEPSEEK_REPAIR_MODEL, "deepseek-v4-pro");
  if (purpose === "planner") return cleanText(env.DEEPSEEK_PLANNER_MODEL, "deepseek-v4-pro");
  return cleanText(env.DEEPSEEK_PLANNER_MODEL || env.DEEPSEEK_MODEL, "deepseek-v4-pro");
}

async function searchVerifiedTravelContext(query: string, city: string, env: any) {
  const fetchedAt = new Date().toISOString();
  const wikiParams = new URLSearchParams({
    action: "query", format: "json", origin: "*", list: "search", utf8: "1", srlimit: "6",
    srsearch: `${cleanText(query)} ${cleanText(city)} 旅游`,
  });
  const providers = await settleTravelProviders({
    wikipedia: fetchJson(`https://zh.wikipedia.org/w/api.php?${wikiParams}`, {}, 12000, "Wikimedia 联网检索"),
    amap: callMcp(AMAP_MCP, "maps_text_search", { keywords: cleanText(query), city: cleanText(city) }, { timeoutMs: 10000, cacheMs: 20 * 60 * 1000 }),
  });
  const wikiRows = providers.wikipedia.status === "ready" ? (providers.wikipedia.data as any)?.query?.search || [] : [];
  const amapRows = providers.amap.status === "ready" ? amapPoiRows(providers.amap.data).slice(0, 6) : [];
  return {
    query: cleanText(query), city: cleanText(city), fetchedAt,
    sources: [
      ...wikiRows.map((row: any) => ({ name: cleanText(row.title), snippet: cleanText(row.snippet).replace(/<[^>]+>/g, ""), source: "中文维基百科", url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(cleanText(row.title).replace(/ /g, "_"))}`, status: "public-context" })),
      ...amapRows.map((row: any) => ({ name: cleanText(row.name), address: cleanText(row.address), type: cleanText(row.type), location: cleanText(row.location), source: "高德地图 MCP", status: "map-poi" })),
    ],
    unavailable: Object.entries(providers).filter(([, value]: any) => value.status === "unavailable").map(([name, value]: any) => ({ name, reason: value.error })),
    note: "联网工具仅返回可追溯的公开页面与地图 POI；未返回的开放、预约、客流和价格信息继续保持 Unknown。",
  };
}

async function deepSeekRequest(env: any, options: {
  purpose: "extract" | "planner" | "repair" | "explain";
  messages: any[];
  jsonMode?: boolean;
  thinking?: boolean;
  maxTokens?: number;
  webTools?: { city: string } | null;
}) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("部署环境尚未配置 DeepSeek API Key");
  const model = deepSeekModel(env, options.purpose);
  const messages = structuredClone(options.messages);
  const toolLog: any[] = [];
  const tools = options.webTools ? [{
    type: "function",
    function: {
      name: "search_verified_travel_context",
      description: "联网查询中国目的地的公开旅游实体和地图 POI。仅在输入知识包不足以核验实体或季节背景时调用；不能把搜索摘要当成实时客流、开放、预约或价格。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "要核验的景点、季节现象或旅行实体，2-80 字" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  }] : undefined;

  for (let turn = 0; turn < 4; turn += 1) {
    const payload: any = {
      model,
      messages,
      max_tokens: options.maxTokens || 6000,
      thinking: { type: options.thinking ? "enabled" : "disabled" },
    };
    if (options.thinking) payload.reasoning_effort = "high";
    if (!options.thinking) payload.temperature = options.jsonMode ? 0.1 : 0.25;
    if (options.jsonMode) payload.response_format = { type: "json_object" };
    if (tools) { payload.tools = tools; payload.tool_choice = "auto"; }
    const result = await fetchJson("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify(payload),
    }, options.thinking ? 120000 : 60000, `DeepSeek ${model}`);
    const message = result?.choices?.[0]?.message;
    if (!message) throw new Error(`DeepSeek ${model} 没有返回消息`);
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      const content = cleanText(message.content);
      if (!content) throw new Error(`DeepSeek ${model} 没有返回内容`);
      return { content, model: cleanText(result?.model, model), toolLog };
    }
    messages.push({ role: "assistant", content: message.content ?? "", reasoning_content: message.reasoning_content ?? "", tool_calls: message.tool_calls });
    for (const call of message.tool_calls.slice(0, 3)) {
      let args: any = {};
      try { args = JSON.parse(cleanText(call?.function?.arguments, "{}")); } catch { args = {}; }
      const query = cleanText(args.query).slice(0, 80);
      const output = query.length >= 2
        ? await searchVerifiedTravelContext(query, options.webTools?.city || "", env)
        : { error: "query 必须为 2—80 字", sources: [] };
      toolLog.push({
        tool: "search_verified_travel_context",
        query,
        resultCount: output.sources?.length || 0,
        fetchedAt: output.fetchedAt || new Date().toISOString(),
        sources: (output.sources || []).slice(0, 6).map((source: any) => ({
          name: cleanText(source.name),
          provider: cleanText(source.source),
          url: cleanText(source.url) || null,
        })),
        unavailable: output.unavailable || [],
      });
      messages.push({ role: "tool", tool_call_id: cleanText(call.id), content: JSON.stringify(output) });
    }
  }
  throw new Error(`DeepSeek ${model} 联网工具调用超过安全上限`);
}

async function deepSeekJson(env: any, options: Parameters<typeof deepSeekRequest>[1]) {
  const first = await deepSeekRequest(env, { ...options, jsonMode: true });
  try { return { value: parseJsonObject(first.content), model: first.model, toolLog: first.toolLog, formatRepaired: false }; }
  catch {
    const repaired = await deepSeekRequest(env, {
      purpose: options.purpose,
      thinking: false,
      maxTokens: options.maxTokens,
      webTools: null,
      jsonMode: true,
      messages: [
        { role: "system", content: "你是 JSON 格式修复器。只修复语法和字段容器，不添加新事实。只输出一个有效 JSON 对象。" },
        { role: "user", content: first.content },
      ],
    });
    return { value: parseJsonObject(repaired.content), model: repaired.model, toolLog: first.toolLog, formatRepaired: true };
  }
}

async function deepSeek(env: any, messages: any[], jsonMode = false, maxTokens = 5000) {
  const result = jsonMode
    ? await deepSeekJson(env, { purpose: "explain", messages, thinking: false, maxTokens })
    : await deepSeekRequest(env, { purpose: "explain", messages, thinking: false, maxTokens });
  return jsonMode ? JSON.stringify((result as any).value) : (result as any).content;
}

function deterministicHints(text: string) {
  const result: any = {};
  const city = text.match(/(?:去|到|前往)\s*([\u4e00-\u9fa5]{2,8}?)(?=(?:市)?(?:旅游|旅行|游玩|出差|玩|\d{1,2}天|[，,。；;\s]))|目的地(?:是|为)?\s*([\u4e00-\u9fa5]{2,8}?)(?:市|，|。|\s)/);
  if (city) result.city = cleanText(city[1] || city[2]).replace(/市$/, "");
  const range = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(?:到|至|—|-)\s*(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/);
  if (range) {
    result.startDate = `${range[1]}-${String(range[2]).padStart(2, "0")}-${String(range[3]).padStart(2, "0")}`;
    const end = `${range[4] || range[1]}-${String(range[5]).padStart(2, "0")}-${String(range[6]).padStart(2, "0")}`;
    result.days = Math.max(1, diffDays(result.startDate, end) + 1);
  }
  if (!range) {
    const singleDate = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    if (singleDate) result.startDate = `${singleDate[1]}-${String(singleDate[2]).padStart(2, "0")}-${String(singleDate[3]).padStart(2, "0")}`;
  }
  const days = text.match(/(?:共|计划|玩|旅行)?\s*(\d{1,2})\s*天(?:\s*(\d{1,2})\s*晚)?/);
  if (days) { result.days = Number(days[1]); if (days[2]) result.nights = Number(days[2]); }
  const party = text.match(/(\d{1,2})\s*(?:个人|人)(?:出行|旅行|游玩)?/);
  if (party) result.partySize = Number(party[1]);
  const required: string[] = [];
  const requiredText = text.match(/(?:一定|必须|必选|务必)(?:能)?去\s*([^，,。；;\n]+)/);
  if (requiredText) required.push(...requiredText[1].split(/[、和与及]/).map(v => v.trim()).filter(v => v.length >= 2 && v.length <= 18));
  if (required.length) result.requiredAttractions = [...new Set(required)];
  const start = text.match(/(?:上午|每天)?\s*(\d{1,2})\s*点(?:左右)?开始/);
  const end = text.match(/(?:晚上|每天)?\s*(\d{1,2})\s*点(?:前|之前)?结束/);
  if (start) result.dayStart = `${String(Number(start[1])).padStart(2, "0")}:00`;
  if (end) {
    const rawHour = Number(end[1]);
    const endHour = /晚上|晚间/.test(end[0]) && rawHour < 12 ? rawHour + 12 : rawHour;
    result.dayEnd = `${String(endHour).padStart(2, "0")}:00`;
  }
  const lodging = text.match(/(?:住宿|酒店)(?:暂定|定|住)?在\s*([^，。；;\n]{2,20})/);
  if (lodging) result.lodgingArea = lodging[1].trim();
  const excludedText = text.match(/(?:不想去|不要去|明确排除|排除)\s*([^，,。；;\n]+)/);
  if (excludedText) result.excludedAttractions = excludedText[1].split(/[、和与及]/).map(v => v.trim()).filter(v => v.length >= 2 && v.length <= 18);
  const preferenceTerms = ["自然", "摄影", "人文", "历史", "文化", "美食", "夜景", "亲子", "建筑", "博物馆", "徒步"];
  const preferences = preferenceTerms.filter((term) => text.includes(term));
  if (preferences.length) result.preferences = preferences;
  return result;
}

function mergeProfile(input: any, ai: any) {
  const text = cleanText(input.freeText);
  const hints = deterministicHints(text);
  const merged = { ...input, ...ai, ...hints };
  const explicitText = (value: unknown) => {
    const normalized = cleanText(value);
    return /^(unknown|未知|未设置|null)$/i.test(normalized) ? "" : normalized;
  };
  const city = explicitText(hints.city) || explicitText(input.city) || explicitText(ai.city);
  const startDate = dateString(hints.startDate, dateString(input.startDate, dateString(ai.startDate, "")));
  const days = clamp(merged.days, 1, 7);
  const budgetValue = Number(merged.budget ?? input.budget);
  const missingFields = [...new Set(list(ai.unknownFields))];
  if (!city && !missingFields.includes("city")) missingFields.push("city");
  if (!startDate && !missingFields.includes("startDate")) missingFields.push("startDate");
  return {
    city: city.replace(/市$/, ""),
    startDate,
    days,
    nights: clamp(merged.nights ?? days - 1, 0, 7),
    partySize: clamp(merged.partySize ?? 1, 1, 20),
    budget: Number.isFinite(budgetValue) && budgetValue > 0 ? clamp(budgetValue, 100, 200000) : 0,
    style: explicitText(merged.style) || explicitText(input.style),
    preferences: [...new Set([...list(input.preferences), ...list(ai.preferences)])].slice(0, 10),
    avoid: [...new Set(list(ai.avoid))].slice(0, 8),
    requiredAttractions: [...new Set([...list(ai.requiredAttractions), ...list(hints.requiredAttractions)])].slice(0, 12),
    pace: cleanText(merged.pace, input.pace || "medium"),
    transport: cleanText(merged.transport, input.transport || "公共交通优先"),
    hotelPreference: explicitText(merged.hotelPreference) || explicitText(input.hotelPreference),
    lodgingArea: cleanText(merged.lodgingArea, ""),
    dayStart: cleanText(merged.dayStart, "09:00"),
    dayEnd: cleanText(merged.dayEnd, "21:00"),
    mealPreference: cleanText(merged.mealPreference, "每天 1—2 个当地特色美食，顺路安排"),
    requestedVariants: list(merged.requestedVariants).length ? list(merged.requestedVariants).slice(0, 3) : ["经典景点覆盖率高", "偏自然和摄影", "避开人流、行程轻松"],
    excludedAttractions: [...new Set([...list(ai.excludedAttractions), ...list(hints.excludedAttractions)])].slice(0, 12),
    adults: clamp(merged.adults ?? merged.partySize ?? 1, 0, 20),
    children: clamp(merged.children ?? 0, 0, 20),
    seniors: clamp(merged.seniors ?? 0, 0, 20),
    budgetLevel: explicitText(merged.budgetLevel) || "Unknown",
    interestPriorities: Array.isArray(ai.interestPriorities) ? ai.interestPriorities.slice(0, 12) : [],
    crowdSensitivity: cleanText(merged.crowdSensitivity, /拥挤|人流|避峰/.test(text) ? "高" : "Unknown"),
    weatherSensitivity: cleanText(merged.weatherSensitivity, /天气|下雨|降雨/.test(text) ? "高" : "Unknown"),
    walkingSensitivity: cleanText(merged.walkingSensitivity, "Unknown"),
    seasonalNeeds: [...new Set(list(ai.seasonalNeeds))].slice(0, 10),
    unknownFields: missingFields.slice(0, 20),
    returnTime: cleanText(merged.returnTime, "Unknown"),
    clarificationNeeded: Boolean(ai.clarificationNeeded) || !city || !startDate,
    clarificationQuestion: !city ? "请先说明一个中国境内的目的城市或区县。" : !startDate ? "请先说明出发日期，再生成可核验的天气、住宿和行程。" : cleanText(ai.clarificationQuestion),
    freeText: text.slice(0, 5000),
  };
}

async function extractProfile(input: any, env: any) {
  const prompt = `请把用户的中国旅行需求整理成严格 json。只提取用户明确表达或可直接计算的信息，不虚构景点、客流、预约、天气、酒店价格，不把偏好提升为必去。\n字段：city,startDate(YYYY-MM-DD),days,nights,partySize,adults,children,seniors,budget,budgetLevel,style,preferences(string[]),interestPriorities([{name,priority}]),avoid(string[]),requiredAttractions(string[]),excludedAttractions(string[]),pace,transport,hotelPreference,lodgingArea,dayStart(HH:mm),dayEnd(HH:mm),mealPreference,crowdSensitivity,weatherSensitivity,walkingSensitivity,seasonalNeeds(string[]),requestedVariants(string[]),returnTime,unknownFields(string[]),clarificationNeeded(boolean),clarificationQuestion(string)。未明确字段填 "Unknown" 或放入 unknownFields，不得自行猜测。当前规划器一次只支持一个明确城市或区县；如果原文只给省份/大区、给出多个目的地但没说明主城市，clarificationNeeded=true。\nJSON 示例：{"city":"杭州","days":4,"requiredAttractions":["西湖"],"preferences":["摄影"],"unknownFields":["儿童情况"]}\n当前表单：${JSON.stringify(input)}\n用户原文：${cleanText(input.freeText)}`;
  const extracted = await deepSeekJson(env, {
    purpose: "extract", thinking: false, maxTokens: 3200,
    messages: [
      { role: "system", content: "你是旅行需求结构化助手。只输出一个 JSON 对象，不输出解释。" },
      { role: "user", content: prompt },
    ],
  });
  const hints = deterministicHints(cleanText(input.freeText));
  const deterministic = { ...input, ...hints };
  const merged = mergeDeterministicProfile(deterministic, extracted.value);
  return { ...mergeProfile(input, merged), extractionModel: extracted.model, extractionFormatRepaired: extracted.formatRepaired };
}

async function searchCities(query: string, limit = 8) {
  if (cleanText(query).length < 2) return [];
  const normalizedQuery = cleanText(query).replace(/市$/, "");
  const common = COMMON_CHINA_CITIES.find(([name]) => name === normalizedQuery);
  if (common) return [{ name: common[0], displayName: `${common[0]}，中国`, lat: common[1], lng: common[2], zoom: 11, countryCode: "cn", source: "常用城市稳定坐标" }];
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
  if (cities.length) return cities;
  const params = new URLSearchParams({ q: `${query}, 中国`, format: "jsonv2", addressdetails: "1", limit: String(Math.min(limit, 5)), countrycodes: "cn", "accept-language": "zh-CN" });
  let data: any[] = [];
  try { data = await fetchJson(`${NOMINATIM}/search?${params}`, {}, 18000, "OSM 城市搜索"); } catch { data = []; }
  return (Array.isArray(data) ? data : []).map((row: any) => {
    const address = row.address || {};
    const name = cleanText(address.city || address.town || address.county || address.state_district || row.name || query).replace(/市$/, "");
    return { name, displayName: cleanText(row.display_name), lat: Number(row.lat), lng: Number(row.lon), zoom: 11, countryCode: "cn", osmType: row.osm_type, osmId: row.osm_id, source: "OSM Nominatim" };
  }).filter((row: any) => row.name && Number.isFinite(row.lat) && !seen.has(row.name) && seen.add(row.name));
}

async function resolveCity(name: string) {
  const results = await searchCities(name, 5);
  if (!results.length) throw new Error(`未在中国范围内验证到目的地“${name}”`);
  const exact = results.find((item: any) => normalizeName(item.name) === normalizeName(name));
  return exact || results[0];
}

async function weatherDirect(city: any, startDate: string, days: number) {
  const params = new URLSearchParams({
    latitude: String(city.lat), longitude: String(city.lng), timezone: "Asia/Shanghai",
    current: "temperature_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
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
      precipitationProbability: raw.daily.precipitation_probability_max[idx], source: "Open-Meteo",
    };
  });
  return { city: city.name, current: raw.current || {}, tripForecast, fetchedAt: new Date().toISOString(), source: "Open-Meteo" };
}

async function weatherFor(city: any, startDate: string, days: number) {
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
    return { city: city.name, current: {}, tripForecast, fetchedAt: new Date().toISOString(), source: "MCPMarket 天气查询", mcpStatus: "ready" };
  } catch (error: any) {
    const fallback: any = await weatherDirect(city, startDate, days);
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

function fallbackPoiCategory(value: string) {
  if (/公园|湖|山|湿地|自然|风景|植物/.test(value)) return "自然景观";
  if (/博物馆|美术馆|展览|纪念馆/.test(value)) return "博物展馆";
  if (/寺|庙|塔|古迹|遗址|故居|历史|文化/.test(value)) return "历史文化";
  return "城市景观";
}

function amapCandidateRecord(row: any, city: any, requiredNames: string[]) {
  const name = cleanText(row?.name || row?.title);
  const poiType = cleanText(row?.type || row?.typeName || row?.category);
  const location = cleanText(row?.location);
  const [lng, lat] = location.split(",").map(Number);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || haversine(city.lat, city.lng, lat, lng) > 80000) return null;
  if (/生活服务|摄影冲印|购物服务|商务住宅|公司企业|医疗保健|汽车服务|金融保险/.test(poiType) && !/景区|景点|公园|博物馆|美术馆|纪念馆|故居|遗址|古镇|寺|庙|塔|湖|山|湿地|街区/.test(name)) return null;
  if (/照相馆|摄影工作室|眼镜|密室|剧本杀|购物城.*店|商场.*店|公司$|医院$|诊所$/.test(name)) return null;
  const requiredByUser = requiredNames.some(required => {
    const wanted = normalizeName(required), actual = normalizeName(name);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
  return {
    id: `amap-${cleanText(row.id, `${lat}-${lng}`)}`, name, lat, lng,
    category: requiredByUser ? "用户必选" : fallbackPoiCategory(`${name} ${poiType}`), poiType,
    durationMin: /博物馆|美术馆|纪念馆/.test(name) ? 120 : /公园|湖|山|湿地|风景/.test(name) ? 110 : 90,
    openingHours: cleanText(row.business?.opentime_today || row.opentime || row.opening_hours),
    website: cleanText(row.website), staticPoiQuality: "高德 POI 坐标已核验",
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
    const params = new URLSearchParams({ key: officialKey, keywords: `${city.name} ${keyword}`, city: city.name, citylimit: "true", types: "风景名胜|公园广场|科教文化服务", extensions: "all", offset: "20", page: "1" });
    return fetchJson(`https://restapi.amap.com/v3/place/text?${params}`, {}, 15000, `高德官方景点兜底“${keyword}”`);
  }) : [];
  const amapCalls = keywords.map(keyword => callMcp(AMAP_MCP, "maps_text_search", {
    keywords: `${city.name} ${keyword}`, city: city.name, types: "风景名胜|公园广场|科教文化服务",
  }, { timeoutMs: 10000, cacheMs: 30 * 60 * 1000 }));
  const nominatimQueries = [...requiredNames, `${city.name} 旅游景点`, `${city.name} 公园`, `${city.name} 博物馆`, `${city.name} 古迹`];
  const nominatimCalls = nominatimQueries.map(query => {
    const params = new URLSearchParams({ q: `${query}, 中国`, format: "jsonv2", addressdetails: "1", extratags: "1", namedetails: "1", limit: "10", countrycodes: "cn", "accept-language": "zh-CN" });
    return fetchJson(`${NOMINATIM}/search?${params}`, {}, 16000, `OSM/Nominatim 景点兜底“${query}”`);
  });
  const [officialResults, amapResults, nominatimResults] = await Promise.all([
    Promise.allSettled(officialCalls), Promise.allSettled(amapCalls), Promise.allSettled(nominatimCalls),
  ]);
  const officialSpots = officialResults.flatMap(result => result.status === "fulfilled" && String(result.value?.status) === "1" ? amapPoiRows(result.value) : []).map(row => amapCandidateRecord(row, city, requiredNames)).filter(Boolean);
  const amapSpots = amapResults.flatMap(result => result.status === "fulfilled" ? amapPoiRows(result.value) : []).map(row => amapCandidateRecord(row, city, requiredNames)).filter(Boolean);
  const nominatimSpots = nominatimResults.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []).map(row => nominatimCandidateRecord(row, city, requiredNames)).filter(Boolean);
  return uniqueSpots([...officialSpots, ...amapSpots, ...nominatimSpots]);
}

async function wikipediaSpots(city: any, limit = 40, requiredNames: string[] = [], preferences: string[] = [], env: any = null) {
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
  const quality = spot.staticPoiQuality === "较高" ? 88 : spot.staticPoiQuality === "一般" ? 68 : 58;
  const completeness = Math.min(100, 45 + (spot.sourceUrl ? 15 : 0) + (spot.lat && spot.lng ? 20 : 0) + (spot.extract ? 12 : 0) + (spot.openingHours ? 8 : 0));
  const required = Boolean(spot.requiredByUser);
  const final = required ? 100 : Math.round(preference * 0.5 + quality * 0.3 + completeness * 0.2);
  return {
    final, required, matched,
    breakdown: { preference, poiQuality: quality, dataCompleteness: completeness },
    basis: "偏好 50% · 静态 POI 质量 30% · 公开数据完整度 20%",
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
    .sort((a, b) => Number(b.requiredByUser) - Number(a.requiredByUser) || b.plannerScore - a.plannerScore || a.name.localeCompare(b.name, "zh-CN"));
}

function uniqueSpots(spots: any[]) {
  const seen = new Set<string>();
  return spots.filter(spot => { const key = normalizeName(spot.name); if (!key || seen.has(key)) return false; seen.add(key); return true; });
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

async function amapOfficialImage(env: any, name: string, city: string) {
  const key = cleanText(env?.AMAP_WEB_KEY);
  if (!key || !name) return null;
  const lookupNames = imageLookupNames(name, city);
  for (const lookupName of lookupNames) {
    const params = new URLSearchParams({ key, keywords: lookupName, city, citylimit: "true", extensions: "all", offset: "20", page: "1" });
    const raw = await fetchJson(`https://restapi.amap.com/v3/place/text?${params}`, {}, 15000, "高德地图官方 Web 服务");
    if (String(raw?.status) !== "1") throw new Error(cleanText(raw?.info, "高德地图官方接口未返回成功状态"));
    const ranked = [...(raw?.pois || [])]
      .map((poi: any) => ({ poi, score: poiImageScore(poi, lookupNames), photo: (poi?.photos || []).map((item: any) => secureImageUrl(item?.url)).find(Boolean) }))
      .filter((item: any) => item.score > 0 && item.photo)
      .sort((a: any, b: any) => b.score - a.score);
    const best = ranked[0];
    if (!best) continue;
    const id = cleanText(best.poi.id);
    return {
      found: true, url: best.photo, source: "高德地图官方 POI 精确照片", provider: "amap-official",
      sourceUrl: id ? `https://www.amap.com/place/${encodeURIComponent(id)}` : "https://www.amap.com/",
      verifiedName: cleanText(best.poi.name, name), matchQuality: poiMatchScore(best.poi.name, lookupNames) === 100 ? "amap-official-exact-poi" : "amap-official-related-poi",
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
  ].map(cleanText).filter(Boolean))];
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

async function amapTransitFor(from: any, to: any, city: any) {
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
    };
  } catch (error: any) {
    return { status: "unavailable", note: cleanText(error?.message, "高德地图 MCP 暂不可用") };
  }
}

async function enrichDayTransit(day: any, city: any) {
  const byName = new Map(day.items.map((item: any) => [item.name, item]));
  await Promise.all(day.blocks.filter((block: any) => block.type === "leg").map(async (block: any) => {
    const from = byName.get(block.from), to = byName.get(block.to);
    if (!from || !to) return;
    const result: any = await amapTransitFor(from, to, city);
    if (result.status === "ready") {
      block.mcpTransport = result;
      if (result.durationMin) {
        block.durationMin = result.durationMin;
        block.endTime = minutesToTime(timeToMinutes(block.startTime, 0) + result.durationMin);
      }
    } else block.mcpStatus = result;
  }));
}

function nearestOrder(items: any[]) {
  if (items.length < 3) return [...items];
  const remaining = items.slice(1);
  const ordered = [items[0]];
  while (remaining.length) {
    const previous = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((candidate, index) => {
      const distance = haversine(previous.lat, previous.lng, candidate.lat, candidate.lng);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered;
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
    const raw = await callMcp(AMAP_MCP, "maps_text_search", { keywords: label, city: city.name }, { timeoutMs: 9000, cacheMs: 30 * 60 * 1000 });
    const row = amapPoiRows(raw)[0];
    const location = cleanText(row?.location).split(",").map(Number);
    if (location.length === 2 && location.every(Number.isFinite)) return { id: "hotel", name: label, lat: location[1], lng: location[0], source: "高德地图 MCP" };
  } catch { /* use the verified city center */ }
  return { id: "hotel", name: label, lat: Number(city.lat), lng: Number(city.lng), source: city.source || "城市中心坐标" };
}

function fallbackMatrix(nodes: any[], fetchedAt: string) {
  const legs: any[] = [];
  for (let fromIndex = 0; fromIndex < nodes.length; fromIndex += 1) {
    for (let toIndex = 0; toIndex < nodes.length; toIndex += 1) {
      if (fromIndex === toIndex) continue;
      const distanceM = Math.round(haversine(nodes[fromIndex].lat, nodes[fromIndex].lng, nodes[toIndex].lat, nodes[toIndex].lng) * 1.25);
      legs.push({ fromId: nodes[fromIndex].id, toId: nodes[toIndex].id, durationMin: Math.max(8, Math.round(distanceM / 260 / 60)), distanceM, source: "坐标距离×1.25 透明估算", quality: "estimated", fetchedAt });
    }
  }
  return { source: "坐标距离×1.25 透明估算", fetchedAt, quality: "estimated", nodes, legs };
}

async function buildTrafficMatrix(profile: any, city: any, spots: any[]) {
  const fetchedAt = new Date().toISOString();
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
      legs.push({ fromId: from.id, toId: to.id, durationMin: Math.max(1, Math.round(seconds / 60)), distanceM: Math.round(distance), source: "OSRM Table 道路路由", quality: "routed", fetchedAt });
    }));
    if (legs.length < nodes.length * (nodes.length - 1) * 0.8) throw new Error("OSRM 矩阵缺失过多");
    return { source: "OSRM Table 道路路由", fetchedAt, quality: "routed", nodes, legs };
  } catch { return fallbackMatrix(nodes, fetchedAt); }
}

function matrixLeg(matrix: any, fromId: string, toId: string) {
  return matrix?.legs?.find((leg: any) => leg.fromId === fromId && leg.toId === toId)
    || matrix?.legs?.find((leg: any) => leg.fromId === toId && leg.toId === fromId)
    || null;
}

function scheduleDay(items: any[], profile: any, dayIndex: number, weather: any) {
  let cursor = timeToMinutes(profile.dayStart, 540);
  const endLimit = timeToMinutes(profile.dayEnd, 1260);
  const blocks: any[] = [];
  const scheduled: any[] = [];
  nearestOrder(items).forEach((original, index, orderedItems) => {
    if (index > 0) {
      const previous = orderedItems[index - 1];
      const distanceM = haversine(previous.lat, previous.lng, original.lat, original.lng) * 1.25;
      const durationMin = Math.max(12, Math.round(distanceM / 260 / 60));
      blocks.push({ type: "leg", from: previous.name, to: original.name, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + durationMin), durationMin, distanceM: Math.round(distanceM), source: "OSRM/透明估算", quality: "estimated" });
      cursor += durationMin;
    }
    if (cursor < 12 * 60 + 30 && cursor + original.durationMin > 12 * 60 + 30) {
      const restStart = Math.max(cursor, 12 * 60);
      blocks.push({ type: "rest", mealType: "lunch", anchor: { lat: original.lat, lng: original.lng }, label: "午餐与休息（就近安排，不跨区追店）", startTime: minutesToTime(restStart), endTime: minutesToTime(restStart + 75), durationMin: 75 });
      cursor = restStart + 75;
    }
    const durationMin = clamp(original.durationMin, 60, 180);
    if (cursor + durationMin > endLimit && scheduled.length) return;
    const spot = { ...original, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + durationMin), durationMin };
    scheduled.push(spot); blocks.push({ type: "attraction", item: spot }); cursor += durationMin;
  });
  if (scheduled.length && !blocks.some((block: any) => block.mealType === "lunch")) {
    const restStart = Math.max(cursor, 12 * 60);
    if (restStart + 75 <= endLimit) {
      const last = scheduled[scheduled.length - 1];
      blocks.push({ type: "rest", mealType: "lunch", anchor: { lat: last.lat, lng: last.lng }, label: "午餐与休息（就近安排，不跨区追店）", startTime: minutesToTime(restStart), endTime: minutesToTime(restStart + 75), durationMin: 75 });
      cursor = restStart + 75;
    }
  }
  if (cursor >= 17 * 60 && cursor + 60 <= endLimit) {
    const last = scheduled[scheduled.length - 1];
    blocks.push({ type: "rest", mealType: "dinner", anchor: last ? { lat: last.lat, lng: last.lng } : null, label: "晚餐（优先选择路线附近的当地风味）", startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + 60), durationMin: 60 });
    cursor += 60;
  }
  if (cursor + 20 < endLimit) blocks.push({ type: "rest", label: "弹性时间 / 返回住宿地", startTime: minutesToTime(cursor), endTime: minutesToTime(Math.min(endLimit, cursor + 30)), durationMin: Math.min(30, endLimit - cursor) });
  return { day: dayIndex + 1, date: weather.date, weekday: weekday(weather.date), theme: scheduled.map(item => item.category).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(" · ") || "城市探索", items: scheduled, blocks, conflicts: [], weather };
}

function distribute(candidates: any[], profile: any, variantIndex: number) {
  const targetPerDay = ["slow", "relax", "轻松"].includes(profile.pace) || variantIndex === 2 ? 2 : 3;
  const required = candidates.filter(item => item.requiredByUser);
  const optional = candidates.filter(item => !item.requiredByUser);
  const rotated = optional.slice(variantIndex * 2).concat(optional.slice(0, variantIndex * 2));
  const days = Array.from({ length: profile.days }, () => [] as any[]);
  required.forEach((spot, index) => days[index % profile.days].push(spot));
  rotated.forEach(spot => {
    const day = days.reduce((best, current) => current.length < best.length ? current : best, days[0]);
    if (day.length < targetPerDay) day.push(spot);
  });
  return days.map(day => nearestOrder(day));
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

type TravelFactStatus = "verified" | "estimated" | "predicted" | "unknown" | "conflicting" | "stale";

function factImportance(subject: string, field: string, required = false) {
  if (required || /预约|开放/.test(field)) return "high";
  if (/天气|交通|酒店价格/.test(`${subject}${field}`)) return "medium";
  return "low";
}

function factImpact(subject: string, field: string, required = false) {
  if (required && /开放|预约/.test(field)) return "可能导致必选节点无法执行，并影响同日后续路线";
  if (/天气/.test(`${subject}${field}`)) return "可能改变户外节点顺序与室内备选方案";
  if (/交通/.test(`${subject}${field}`)) return "可能压缩后续景点与用餐缓冲";
  if (/客流/.test(field)) return "可能影响到访时段与同类型替代点选择";
  if (/酒店价格/.test(field)) return "可能改变住宿预算，但不直接改变日间路线";
  return "对当前路线影响有限";
}

function buildTravelFacts(plan: any, profile: any) {
  const facts: any[] = [];
  const add = (fact: any) => facts.push({
    id: `fact-${facts.length + 1}`,
    updatedAt: fact.updatedAt || plan.generatedAt,
    confidence: fact.confidence ?? (fact.status === "verified" ? 0.9 : fact.status === "estimated" ? 0.68 : fact.status === "predicted" ? 0.55 : 0),
    ...fact,
  });
  for (const day of plan.daysPlan || []) {
    const weatherReady = day.weather?.quality === "forecast";
    add({
      subject: `${day.date} 天气`, field: "逐日预报", value: weatherReady ? {
        weatherCode: day.weather.weatherCode,
        temperatureMin: day.weather.temperatureMin,
        temperatureMax: day.weather.temperatureMax,
        precipitationProbability: day.weather.precipitationProbability,
      } : null,
      status: weatherReady ? "verified" : "unknown", sourceType: weatherReady ? "weather-service" : "none",
      sourceName: weatherReady ? cleanText(plan.weather?.source, "天气服务") : "预报范围外或服务未返回",
      sourceUrl: null, importance: "medium",
      uncertaintyReason: weatherReady ? null : cleanText(day.weather?.note, "没有可用于该日期的预报"),
      downstreamImpact: factImpact("天气", "逐日预报"),
    });
    add({
      subject: `Day ${day.day} 路线`, field: "道路路径与耗时", value: { distanceM: day.route?.distance || 0, durationSeconds: day.route?.duration || 0 },
      status: ["routed", "exact"].includes(day.route?.quality) ? "verified" : "estimated",
      sourceType: day.route?.quality === "routed" ? "routing-service" : "calculation",
      sourceName: cleanText(day.route?.source, "路线计算"), sourceUrl: null, importance: "medium",
      uncertaintyReason: day.route?.quality === "estimated" ? "路线服务未返回几何，采用已披露的坐标估算" : null,
      downstreamImpact: factImpact("交通", "道路路径与耗时"),
    });
    for (const spot of day.items || []) {
      const openingKnown = Boolean(spot.openingHours);
      add({
        subject: spot.name, field: "开放时间", value: openingKnown ? spot.openingHours : null,
        status: openingKnown ? "estimated" : "unknown", sourceType: openingKnown ? "poi-public-data" : "none",
        sourceName: openingKnown ? cleanText(spot.sourceName, "景点公开页面 / 地图标注") : "未取得景区官方当日公告",
        sourceUrl: spot.sourceUrl || null, importance: factImportance(spot.name, "开放时间", spot.requiredByUser),
        uncertaintyReason: openingKnown ? "公开规则不等同于出行当日临时公告" : "公开数据未标注开放时间",
        downstreamImpact: factImpact(spot.name, "开放时间", spot.requiredByUser),
      });
      add({
        subject: spot.name, field: "预约状态", value: null, status: "unknown", sourceType: "none",
        sourceName: "景区官方预约接口未接入", sourceUrl: spot.website || spot.sourceUrl || null,
        importance: factImportance(spot.name, "预约状态", spot.requiredByUser),
        uncertaintyReason: "没有可验证的指定日期预约余量", downstreamImpact: factImpact(spot.name, "预约状态", spot.requiredByUser),
      });
      const crowdKnown = spot.crowd?.score != null;
      add({
        subject: spot.name, field: "拥挤风险", value: crowdKnown ? { score: spot.crowd.score, label: spot.crowd.label } : null,
        status: crowdKnown ? "predicted" : "unknown", sourceType: crowdKnown ? "prediction" : "none",
        sourceName: crowdKnown ? cleanText(spot.crowd.source, "风险预测") : "无可验证官方客流来源",
        sourceUrl: null, importance: "medium", confidence: crowdKnown ? Number(spot.crowd.confidence || 0.5) : 0,
        uncertaintyReason: crowdKnown ? "预测不等于实时客流" : "未取得实时客流或可靠预测输入",
        downstreamImpact: factImpact(spot.name, "客流"),
      });
    }
    for (const block of (day.blocks || []).filter((item: any) => item.type === "leg")) {
      const hasMcp = Boolean(block.mcpTransport);
      add({
        subject: `${block.from} → ${block.to}`, field: "公共交通耗时", value: hasMcp ? block.mcpTransport.durationMin : block.durationMin,
        status: hasMcp ? "estimated" : "unknown", sourceType: hasMcp ? "map-service" : "none",
        sourceName: hasMcp ? cleanText(block.mcpTransport.source, "高德地图 MCP") : "未取得公交 / 地铁方案",
        sourceUrl: null, importance: "medium", confidence: hasMcp ? 0.72 : 0,
        uncertaintyReason: hasMcp ? "地图规划耗时不是实时班次承诺" : cleanText(block.mcpStatus?.note, "仅有道路耗时参考"),
        downstreamImpact: factImpact("交通", "公共交通耗时"),
      });
    }
  }
  const candidates = plan.hotelPlan?.candidates || [];
  if (candidates.length) {
    const priced = candidates.find((item: any) => Number(item.price) > 0);
    add({
      subject: cleanText(priced?.name || candidates[0]?.name, "住宿候选"), field: "酒店价格", value: priced ? Number(priced.price) : null,
      status: priced ? "estimated" : "unknown", sourceType: priced ? "hotel-or-map-service" : "none",
      sourceName: cleanText(priced?.source, "酒店 / 地图服务"), sourceUrl: priced?.sourceUrl || null, importance: "medium",
      uncertaintyReason: priced ? "为来源参考价，指定日期房态与成交价仍需下单复核" : "候选酒店未返回可追溯价格",
      downstreamImpact: factImpact("酒店", "酒店价格"),
    });
  }
  return facts;
}

function analyzePlanTrust(plan: any, profile: any) {
  const facts = buildTravelFacts(plan, profile);
  const unknown = facts.filter(fact => ["unknown", "conflicting", "stale"].includes(fact.status));
  const weight: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const minimumVerification = [...unknown]
    .sort((a, b) => (weight[b.importance] || 0) - (weight[a.importance] || 0))
    .slice(0, 6)
    .map((fact, index) => ({
      rank: index + 1, factId: fact.id, subject: fact.subject, field: fact.field, reason: fact.uncertaintyReason,
      impact: fact.downstreamImpact, action: fact.sourceUrl ? "打开来源并在出发前复核" : /预约|开放/.test(fact.field) ? "查看景区官方公告或预约入口" : "临近出发时重新查询",
    }));
  const evaluation = plan.evaluation || {};
  const legs = plan.daysPlan.flatMap((day: any) => day.blocks || []).filter((block: any) => block.type === "leg");
  const explicitBuffers = plan.daysPlan.flatMap((day: any) => day.blocks || []).filter((block: any) => block.type === "rest" && /弹性/.test(block.label || "")).map((block: any) => Number(block.durationMin || 0));
  const minBufferMinutes = explicitBuffers.length ? Math.min(...explicitBuffers) : 0;
  const requiredUnknowns = unknown.filter(fact => fact.importance === "high").length;
  const informationCompleteness = facts.length ? Math.round(facts.filter(fact => !["unknown", "conflicting", "stale"].includes(fact.status)).length / facts.length * 100) : 0;
  const fragilityScore = clamp(Math.round(24 + Math.max(0, 30 - minBufferMinutes) * 0.7 + requiredUnknowns * 8 + Math.max(0, Number(evaluation.evidence?.longestLegMinutes || 0) - 45) * 0.35), 0, 100);
  const reliability = clamp(Math.round(Number(evaluation.overall || 0) * 0.68 + informationCompleteness * 0.22 + (100 - fragilityScore) * 0.1), 0, 100);
  const requiredNodes = plan.daysPlan.flatMap((day: any) => day.items || []).filter((item: any) => item.requiredByUser);
  const criticalNodes = requiredNodes.map((item: any) => ({ name: item.name, reason: "用户硬约束；失败会直接降低必选项覆盖率" }));
  const longestLeg = [...legs].sort((a: any, b: any) => Number(b.durationMin || 0) - Number(a.durationMin || 0))[0];
  if (longestLeg) criticalNodes.push({ name: `${longestLeg.from} → ${longestLeg.to}`, reason: `本方案最长交通段 ${longestLeg.durationMin} 分钟` });
  const scenarios = [
    { id: "late-start", name: "晚出发 45 分钟", pressure: 45, basis: "将首个节点整体后移，不代表真实延误" },
    { id: "queue-delay", name: "热门点排队增加 60 分钟", pressure: 60, basis: "统一增加排队时长的情景模拟" },
    { id: "transit-delay", name: "交通延误 30 分钟", pressure: 30, basis: "最长交通段增加 30 分钟的情景模拟" },
    { id: "rain", name: "户外节点遇雨", pressure: 35, basis: "仅测试户外节点可替换性，不是天气预测" },
    { id: "closure", name: "一个关键景点临时关闭", pressure: 75, basis: "移除单个关键节点后的结构测试" },
    { id: "fatigue", name: "体力下降、减少一个节点", pressure: 40, basis: "删除每日末尾可选节点的情景模拟" },
  ].map(item => {
    const capacity = minBufferMinutes + Math.max(0, 70 - Number(evaluation.evidence?.longestLegMinutes || 0)) * 0.35 + (plan.variant === "relax" ? 18 : 0);
    const closurePenalty = item.id === "closure" && requiredNodes.length ? 30 : 0;
    const score = Math.round(capacity - item.pressure - closurePenalty);
    return { ...item, type: "simulation", outcome: score >= 0 ? "resilient" : score >= -35 ? "repairable" : "fragile", note: score >= 0 ? "现有缓冲可吸收" : score >= -35 ? "需缩短或替换一个非必选节点" : "会影响关键节点，需重新排序或启用替代方案" };
  });
  return {
    travelFacts: facts,
    uncertainty: { count: unknown.length, importantCount: requiredUnknowns, items: unknown },
    minimumVerification,
    compiler: {
      version: "2.0", reliability, informationCompleteness, minBufferMinutes,
      constraintScore: Number(evaluation.constraintSatisfaction || 0),
      timeRisk: Number(evaluation.evidence?.longestLegMinutes || 0) > 60 || minBufferMinutes < 20 ? "high" : minBufferMinutes < 35 ? "medium" : "low",
      weatherRisk: facts.some(fact => fact.field === "逐日预报" && fact.status === "unknown") ? "unknown" : facts.some(fact => fact.field === "逐日预报" && Number(fact.value?.precipitationProbability || 0) >= 60) ? "medium" : "low",
      crowdRisk: facts.some(fact => fact.field === "拥挤风险" && fact.status === "unknown") ? "unknown" : "predicted",
      reservationRisk: requiredUnknowns ? "high" : unknown.some(fact => fact.field === "预约状态") ? "medium" : "low",
      status: reliability >= 78 && !requiredUnknowns ? "可执行" : reliability >= 58 ? "可执行，但需完成关键核验" : "风险较高，建议先核验再出发",
      note: "由工具事实、硬约束、路线耗时、缓冲和未知项计算；不是模型自报分数。",
    },
    fragility: {
      score: fragilityScore, level: fragilityScore >= 70 ? "high" : fragilityScore >= 42 ? "medium" : "low",
      fixedNodeCount: requiredNodes.length, dependencyCount: legs.length + requiredNodes.length,
      singlePointFailureCount: requiredUnknowns, minBufferMinutes,
      alternativesAvailable: Math.max(0, Number(plan.candidatePool?.filter((item: any) => !item.selected).length || 0)),
      note: "分数越高表示越脆弱；依据固定节点、依赖、最小缓冲和关键未知项计算。",
    },
    criticalPath: { nodes: criticalNodes.slice(0, 6), note: "关键路径用于说明哪些节点最容易把延误传导到后续行程。" },
    stressTest: {
      type: "simulation", label: "情景模拟（不是实时预测）", scenarios,
      resilientCount: scenarios.filter(item => item.outcome === "resilient").length,
      repairableCount: scenarios.filter(item => item.outcome === "repairable").length,
    },
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
4. 先保证可执行性，再优化覆盖率。不得安排开放时间冲突、明显折返、超出每日时段或不合理夜景时段。
5. 三套方案分别优化：hot=经典覆盖；niche=自然摄影和合理光线/季节；relax=少景点、大缓冲、透明避峰风险。三套不能只换名字或交换一两个点。
6. 客流无官方实时数据时只可说 Unknown 或基于节假日/时段的 Prediction；不得宣称已实时避峰。
7. 推荐理由必须简短并引用 evidenceRefs；每个景点要提供交通方式、矩阵耗时、调整条件和候选池内替代点。
8. 每套天数严格等于 profile.days；首次分目标调用时只输出调用方指定的一套，统一修复调用时输出完整三套。结构示例：${JSON.stringify(PLANNER_JSON_EXAMPLE)}`;

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

function fallbackPlannerDraft(profile: any, spots: any[], matrix: any, reason: string) {
  const variants = [0, 1, 2].map((variantIndex) => {
    const buckets = distribute(spots, profile, variantIndex);
    return {
      id: ["hot", "niche", "relax"][variantIndex],
      title: ["经典覆盖（透明降级）", "自然摄影（透明降级）", "轻松避峰（透明降级）"][variantIndex],
      style: ["经典", "自然摄影", "轻松避峰"][variantIndex],
      strategy: `DeepSeek 暂不可用；按候选评分、必去约束和交通矩阵生成的确定性降级方案。原因：${reason}`,
      days: buckets.map((items: any[], dayIndex: number) => {
        let cursor = timeToMinutes(profile.dayStart, 540);
        let previous: any = null;
        const activities: any[] = [];
        nearestOrder(items).forEach((spot: any, index: number) => {
          const leg = previous ? matrixLeg(matrix, previous.id, spot.id) : matrixLeg(matrix, "hotel", spot.id);
          if (previous) cursor += Number(leg?.durationMin || 20);
          const durationMin = Math.min(variantIndex === 2 ? 120 : 150, Number(spot.durationMin || 120));
          if (cursor < 12 * 60 && cursor + durationMin > 12 * 60) {
            activities.push({ type: "meal", label: "午餐与休息", startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + 75), durationMin: 75, reason: "正常用餐与休息", evidenceRefs: [] });
            cursor += 75;
          }
          activities.push({ type: "attraction", spotId: spot.id, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + durationMin), durationMin, transportFromPrevious: previous ? { mode: "公共交通 / 打车", durationMin: Number(leg?.durationMin || 20), matrixKey: `${previous.id}->${spot.id}` } : undefined, reason: spot.requiredByUser ? "用户必去硬约束" : "候选评分与空间顺路", evidenceRefs: [spot.id, "traffic-matrix"] });
          cursor += durationMin;
          previous = spot;
        });
        if (!activities.some(item => item.type === "meal")) activities.push({ type: "meal", label: "午餐与休息", startTime: "12:00", endTime: "13:15", durationMin: 75, reason: "正常用餐与休息", evidenceRefs: [] });
        activities.push({ type: "rest", label: "弹性休息", startTime: minutesToTime(Math.min(cursor, timeToMinutes(profile.dayEnd, 1260) - 30)), endTime: minutesToTime(Math.min(cursor + 30, timeToMinutes(profile.dayEnd, 1260))), durationMin: 30, reason: "吸收排队和交通波动", evidenceRefs: [] });
        return { day: dayIndex + 1, theme: "透明降级路线", activities, returnHotelTime: minutesToTime(Math.min(cursor + 30, timeToMinutes(profile.dayEnd, 1260))), totalActivityMin: activities.reduce((sum, item) => sum + Number(item.durationMin || 0), 0), totalTransportMin: activities.reduce((sum, item) => sum + Number(item.transportFromPrevious?.durationMin || 0), 0) };
      }),
    };
  });
  return { variants, degraded: true, degradationReason: reason };
}

async function generatePlannerDraft(profile: any, knowledge: any, env: any, replanContext: any) {
  assertPlannerContext(knowledge);
  const modelAudit = { plannerModel: deepSeekModel(env, "planner"), repairModel: deepSeekModel(env, "repair"), toolCalls: [] as any[], formatRepairs: 0, repairRounds: 0, degraded: false, degradationReason: "", compilerIssues: [] as any[] };
  let draft: any;
  const objectives = [
    { id: "hot", name: "经典覆盖", goal: "优先代表性与必去覆盖，控制跨区移动；不要把购物 POI 当景点。" },
    { id: "niche", name: "自然摄影", goal: "优先自然、摄影、季节证据和合理光线；恶劣天气给候选池内室内替代。" },
    { id: "relax", name: "轻松避峰", goal: "降低每日景点数、增加缓冲；客流未知时不得宣称实时避峰成功。" },
  ];
  const initialResults = await Promise.allSettled(objectives.map(async (objective) => {
    const messages = [
      { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n本次只生成方案 ${objective.id}（${objective.name}），variants 数组只放这一套；其目标函数是：${objective.goal}\n联网工具已提供。请先调用 search_verified_travel_context 核验一个与本方案最相关的季节或景点实体，再完成 JSON；工具结果不能升级为实时客流、预约或价格。` },
      { role: "user", content: JSON.stringify({ task: replanContext ? "局部重规划" : "首次规划", objective, knowledge, replanContext, instruction: "输出这一套方案的完整活动时间轴 json；不要只输出景点 ID 列表。" }) },
    ];
    try {
      return { response: await deepSeekJson(env, { purpose: "planner", thinking: true, maxTokens: 12000, webTools: { city: profile.city }, messages }), thinkingFallback: false, fallbackReason: "" };
    } catch (error: any) {
      const fallbackReason = cleanText(error?.message, `${objective.name} thinking 调用失败`);
      const response = await deepSeekJson(env, { purpose: "planner", thinking: false, maxTokens: 7500, webTools: { city: profile.city }, messages: [...messages, { role: "user", content: "thinking 模式上游未能完成。请作为透明降级，用非 thinking 模式直接输出同一 JSON 方案；不得改变事实与硬约束。" }] });
      return { response, thinkingFallback: true, fallbackReason };
    }
  }));
  const deterministicFallback = fallbackPlannerDraft(profile, knowledge.spots, knowledge.trafficMatrix, "单个 V4 Pro 方案调用失败");
  const rawVariants: any[] = [];
  const initialErrors: string[] = [];
  let failedVariantCount = 0;
  initialResults.forEach((result, index) => {
    if (result.status === "fulfilled" && Array.isArray((result.value.response.value as any)?.variants) && (result.value.response.value as any).variants[0]) {
      rawVariants.push((result.value.response.value as any).variants[0]);
      modelAudit.plannerModel = result.value.response.model;
      modelAudit.toolCalls.push(...result.value.response.toolLog.map((entry: any) => ({ ...entry, variant: objectives[index].id })));
      if (result.value.response.formatRepaired) modelAudit.formatRepairs += 1;
      if (result.value.thinkingFallback) initialErrors.push(`${objectives[index].name} thinking 降级：${result.value.fallbackReason}`);
    } else {
      rawVariants.push(deterministicFallback.variants[index]);
      failedVariantCount += 1;
      initialErrors.push(result.status === "rejected" ? cleanText(result.reason?.message, `方案 ${objectives[index].id} 调用失败`) : `方案 ${objectives[index].id} 返回结构不完整`);
    }
  });
  if (initialErrors.length) {
    modelAudit.degraded = true;
    modelAudit.degradationReason = initialErrors.join("；");
  }
  draft = normalizePlannerDraft({ variants: rawVariants }, profile);
  if (failedVariantCount === 3) return { draft, audit: auditPlannerDraft(draft, knowledge), modelAudit };

  let audit = auditPlannerDraft(draft, knowledge);
  for (let round = 0; round < 2 && audit.needsRepair; round += 1) {
    try {
      const repaired = await deepSeekJson(env, {
        purpose: "repair", thinking: true, maxTokens: 10000, webTools: null,
        messages: [
          { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n你现在是冲突修复器。只修复问题清单涉及的日期或节点；硬约束不能删除。输出修复后的完整三套方案 json。` },
          { role: "user", content: JSON.stringify({ knowledge, draft, issues: audit.issues, hardConstraints: { requiredAttractions: profile.requiredAttractions, dayStart: profile.dayStart, dayEnd: profile.dayEnd, days: profile.days }, softConstraints: { preferences: profile.preferences, pace: profile.pace }, replanContext }) },
        ],
      });
      draft = normalizePlannerDraft(repaired.value, profile);
      modelAudit.repairModel = repaired.model;
      modelAudit.repairRounds += 1;
      if (repaired.formatRepaired) modelAudit.formatRepairs += 1;
      audit = auditPlannerDraft(draft, knowledge);
    } catch (error: any) {
      modelAudit.compilerIssues.push({ code: "REPAIR_FAILED", message: cleanText(error?.message) });
      break;
    }
  }
  modelAudit.compilerIssues.push(...audit.issues);
  if (audit.hardIssues.length) {
    modelAudit.degraded = true;
    modelAudit.degradationReason = `两轮修复后仍有 ${audit.hardIssues.length} 个硬冲突`;
    draft = fallbackPlannerDraft(profile, knowledge.spots, knowledge.trafficMatrix, modelAudit.degradationReason);
    audit = auditPlannerDraft(draft, knowledge);
  }
  return { draft, audit, modelAudit };
}

function planDayFromDraft(dayDraft: any, dayIndex: number, spotsById: Map<string, any>, matrix: any, weather: any, profile: any) {
  const blocks: any[] = [];
  const items: any[] = [];
  let previousSpot: any = null;
  const ordered = [...(dayDraft.activities || [])].sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
  for (const activity of ordered) {
    if (activity.type === "attraction") {
      const base = spotsById.get(activity.spotId);
      if (!base) continue;
      if (previousSpot) {
        const leg = matrixLeg(matrix, previousSpot.id, base.id);
        const durationMin = Number(leg?.durationMin || activity.transportFromPrevious?.durationMin || 20);
        const attractionStart = timeToMinutes(activity.startTime, timeToMinutes(profile.dayStart, 540));
        blocks.push({ type: "leg", from: previousSpot.name, to: base.name, startTime: minutesToTime(Math.max(0, attractionStart - durationMin)), endTime: activity.startTime, durationMin, distanceM: Number(leg?.distanceM || 0), source: cleanText(leg?.source, "交通矩阵"), quality: cleanText(leg?.quality, "estimated"), fetchedAt: leg?.fetchedAt, mode: cleanText(activity.transportFromPrevious?.mode, "公共交通 / 打车") });
      }
      const item = { ...base, startTime: activity.startTime, endTime: activity.endTime, durationMin: activity.durationMin, recommendationReason: activity.reason, evidenceRefs: activity.evidenceRefs, alternativeSpotIds: activity.alternativeSpotIds, adjustmentCondition: activity.adjustmentCondition };
      items.push(item); blocks.push({ type: "attraction", item, startTime: item.startTime, endTime: item.endTime, durationMin: item.durationMin }); previousSpot = item;
    } else {
      blocks.push({ type: "rest", mealType: activity.type === "meal" ? (/晚餐/.test(activity.label || "") ? "dinner" : "lunch") : undefined, label: activity.label || (activity.type === "meal" ? "用餐与休息" : "弹性休息"), startTime: activity.startTime, endTime: activity.endTime, durationMin: activity.durationMin, reason: activity.reason });
    }
  }
  return { day: dayIndex + 1, date: weather.date, weekday: weekday(weather.date), theme: dayDraft.theme || "城市探索", items, blocks, conflicts: [], weather, returnHotelTime: dayDraft.returnHotelTime, totalActivityMin: dayDraft.totalActivityMin, totalTransportMin: dayDraft.totalTransportMin };
}

export async function handleTravelApi(request: Request, env: any, url: URL): Promise<Response | null> {
  try {
    if (url.pathname === "/api/health") return json({
      ok: true,
      ai: {
        status: env?.DEEPSEEK_API_KEY ? "configured" : "unconfigured",
        extractionModel: deepSeekModel(env, "extract"), plannerModel: deepSeekModel(env, "planner"), repairModel: deepSeekModel(env, "repair"),
        thinking: { planner: "enabled", repair: "enabled", reasoningContentExposed: false },
        network: { enabled: true, mode: "DeepSeek function tool calls", tools: ["Wikimedia 公开检索", "高德地图 MCP POI 查询"] },
        note: "先结构化需求，再获取真实工具数据和交通矩阵；V4 Pro 输出完整时间轴，编译器发现问题后由 V4 Pro 最多修复两轮。",
      },
      services: [
        { name: "天气查询 MCP", provider: "MCPMarket", status: "live", note: "Open-Meteo 逐小时预报；MCP 失败时使用 Open-Meteo 直连兜底" },
        { name: "酒店与参考价", provider: "高德地图官方 + MCPMarket", status: env?.AMAP_WEB_KEY ? "live" : "partial", note: "地图 POI 保证候选真实性；展示高德最低参考价或酒店 MCP 在售套餐参考价，并明确非指定日期成交价" },
        { name: "高德官方景点图片", provider: "高德 Web 服务 API", status: env?.AMAP_WEB_KEY ? "live" : "unconfigured", note: "使用用户 Key 做景点实体精确搜索，作为图片首选" },
        { name: "Unsplash 景点图片", provider: "Unsplash API", status: env?.UNSPLASH_ACCESS_KEY ? "live" : "unconfigured", note: "高德无照片时按景点名与城市补图，并显示摄影师与 Unsplash 归因" },
        { name: "高德地图 AMap", provider: "MCPMarket / 高德开放平台", status: "live", note: "POI、精确图片与公交路线；共享免费额度耗尽时透明回退" },
        { name: "中文维基百科景点检索", provider: "Wikimedia", status: "live", note: "公开页面、摘要、坐标与精确页面图片兜底" },
        { name: "OpenStreetMap / Nominatim", provider: "OSM", status: "live", note: "城市和用户必选景点核验兜底" },
        { name: "OSRM", provider: "OSRM", status: "live", note: "地图线路几何；失败时透明估算" },
        { name: "DeepSeek 联网工具", provider: "服务端受控 Tool Calls", status: "live", note: "模型可调用 Wikimedia 与高德查询；搜索结果不能冒充实时客流、预约或价格" },
        { name: "官方客流与预约", provider: "未接入", status: "offline", note: "保持未知，不由 AI 编造" },
      ],
    });

    if (url.pathname === "/api/providers/status") return json({ providers: {
      weather: { name: "天气", role: "MCPMarket 天气查询", status: "ready", fallback: "Open-Meteo 直连；超出预报范围时明确显示不可用" },
      spots: { name: "景点", role: "中文维基百科 + OSM + 高德 POI", status: "ready", fallback: "高德免费共享额度不可用时保留精确页面图片和 OSM 核验" },
      route: { name: "道路路线", role: "OSRM 地图几何 + 高德 MCP", status: "ready", fallback: "坐标距离×1.25 透明估算" },
      transit: { name: "公共交通", role: "高德地图 MCP", status: "ready", fallback: "无班次或额度不足时显示道路耗时参考" },
      crowd: { name: "客流与预约", role: "景区官方来源待接入", status: "unconfigured", fallback: "保持未知" },
      hotel: { name: "住宿候选", role: "高德地图官方酒店 POI + MCPMarket 在售产品", status: env?.AMAP_WEB_KEY ? "ready" : "partial", fallback: "仅保留用户住宿区域；没有来源价格时不补写假价" },
      images: { name: "景点图片", role: "高德官方精确 POI + Unsplash + Wikimedia", status: env?.AMAP_WEB_KEY || env?.UNSPLASH_ACCESS_KEY ? "ready" : "unconfigured", fallback: "高德官方无照片时依次使用 Unsplash、高德免费 MCP 和中文维基百科实体图片" },
      aiSearch: { name: "AI 联网查询", role: "DeepSeek Tool Calls -> Wikimedia / 高德地图 MCP", status: env?.DEEPSEEK_API_KEY ? "ready" : "unconfigured", fallback: "模型不可用时仍由后端直接获取数据；降级结果明确标注" },
    } });

    if (url.pathname === "/api/cities") {
      const centers = COMMON_CHINA_CITIES.map(([name, lat, lng]) => ({ name, displayName: `${name}，中国`, lat, lng, zoom: 11, countryCode: "cn", source: "内置城市入口坐标" }));
      return json({ cities: centers, scope: "中国", note: "仅为常用城市入口；任意中国城市仍通过搜索接口实时查找" });
    }

    if (url.pathname === "/api/city-search") return json({ cities: await searchCities(cleanText(url.searchParams.get("q")), 8), scope: "中国" });

    if (url.pathname === "/api/weather") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"));
      return json(await weatherFor(city, dateString(url.searchParams.get("startDate")), clamp(url.searchParams.get("days"), 1, 7)));
    }

    if (url.pathname === "/api/hotels") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"));
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
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"));
      const spots = await wikipediaSpots(city, clamp(url.searchParams.get("limit"), 1, 50), [], [], env);
      return json({ city: city.name, spots, count: spots.length, source: "中文维基百科公开页面与坐标", fetchedAt: new Date().toISOString() });
    }

    if (url.pathname === "/api/image") {
      const imageUrl = cleanText(url.searchParams.get("image"));
      const wikipedia = cleanText(url.searchParams.get("wikipedia"));
      const name = cleanText(url.searchParams.get("name"));
      const cityName = cleanText(url.searchParams.get("city"));
      const excluded = new Set(cleanText(url.searchParams.get("exclude")).split(",").filter(Boolean));
      const attempts: string[] = [];
      if (name && cityName && !excluded.has("amap-official")) {
        try {
          const official = await amapOfficialImage(env, name, cityName);
          if (official) return json(official);
          attempts.push("高德官方未找到匹配照片");
        } catch (error: any) { attempts.push(`高德官方：${cleanText(error?.message, "不可用")}`); }
      }
      if (!excluded.has("wikimedia")) {
        try {
          const parsed = new URL(imageUrl);
          if (parsed.protocol === "https:" && parsed.hostname.endsWith(".wikimedia.org")) {
            const title = wikipedia.replace(/^zh:/, "");
            return json({ found: true, url: imageUrl, source: "Wikimedia 精确页面图片", provider: "wikimedia", sourceUrl: title ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : "https://commons.wikimedia.org/" });
          }
        } catch { /* no verified image */ }
      }
      let wikiEntity: any = null;
      if (name && cityName) {
        try {
          wikiEntity = await wikipediaExactEntity(name, cityName);
          if (!excluded.has("wikimedia") && wikiEntity?.found) return json(wikiEntity);
          attempts.push("中文维基百科精确页面无图片");
        } catch (error: any) { attempts.push(`中文维基百科：${cleanText(error?.message, "不可用")}`); }
      }
      if (name && cityName && !excluded.has("unsplash")) {
        try {
          const unsplash = await unsplashImage(env, name, cityName, wikiEntity?.englishName || "");
          if (unsplash) return json(unsplash);
          attempts.push("Unsplash 未找到相关照片");
        } catch (error: any) { attempts.push(`Unsplash：${cleanText(error?.message, "不可用")}`); }
      }
      if (name && cityName && !excluded.has("amap-mcp")) {
        try {
          const amap = await amapPoiForSpot(name, cityName);
          if (amap?.photo) return json({
            found: true, url: amap.photo, source: "高德地图 POI 精确照片", provider: "amap-mcp",
            sourceUrl: amap.id ? `https://www.amap.com/place/${encodeURIComponent(amap.id)}` : "https://www.amap.com/",
            verifiedName: amap.name,
          });
          attempts.push("高德 MCP 未找到匹配照片");
        } catch (error: any) { attempts.push(`高德 MCP：${cleanText(error?.message, "不可用")}`); }
      }
      return json({ found: false, reason: "高德、中文维基百科与 Unsplash 均未找到可验证图片；不使用无关猜图", attempts });
    }

    if (url.pathname === "/api/agent" && request.method === "POST") {
      const body = await request.json();
      const message = await deepSeek(env, [
        { role: "system", content: "你是旅行行程解释助手。只能依据用户提供的已核验上下文回答。凡实时客流、预约、房价、开放状态等上下文中为未知的内容，必须明确说未知，不得推测。回答简洁、中文。" },
        { role: "user", content: `问题：${cleanText(body.prompt)}\n已核验上下文：${JSON.stringify(body.context || {})}` },
      ], false, 1800);
      return json({ message, model: deepSeekModel(env, "explain") });
    }

    if (url.pathname === "/api/plan/start" && request.method === "POST") {
      const input = await request.json();
      const profile = await extractProfile(input, env);
      if (profile.clarificationNeeded) return json({ error: { message: profile.clarificationQuestion || "请先明确一个主要目的城市或区县，再生成行程。" }, profile }, 409);
      const city = await resolveCity(profile.city);
      profile.city = city.name;
      const replanInput = input?.replanContext;
      const replanContext = replanInput && Array.isArray(replanInput.days) ? {
        adjustment: cleanText(replanInput.adjustment).slice(0, 800),
        activeVariant: ["relax", "hot", "niche"].includes(cleanText(replanInput.activeVariant)) ? cleanText(replanInput.activeVariant) : "relax",
        days: replanInput.days.slice(0, 7).map((day: any, index: number) => ({
          day: Number(day?.day || index + 1),
          spotIds: Array.isArray(day?.spotIds) ? day.spotIds.map((value: any) => cleanText(value)).filter(Boolean).slice(0, 5) : [],
          items: Array.isArray(day?.items) ? day.items.slice(0, 5).map((item: any) => ({
            id: cleanText(item?.id), name: cleanText(item?.name),
            lat: Number.isFinite(Number(item?.lat)) ? Number(item.lat) : undefined,
            lng: Number.isFinite(Number(item?.lng)) ? Number(item.lng) : undefined,
            category: cleanText(item?.category), startTime: cleanText(item?.startTime), endTime: cleanText(item?.endTime),
            durationMin: clamp(item?.durationMin, 20, 360), openingHours: cleanText(item?.openingHours) || null,
            sourceName: cleanText(item?.sourceName), sourceUrl: cleanText(item?.sourceUrl) || null,
            fetchedAt: cleanText(item?.fetchedAt), requiredByUser: Boolean(item?.requiredByUser),
          })).filter((item: any) => item.id && item.name) : [],
        })),
      } : null;
      const envelope = { version: 2, createdAt: Date.now(), profile, city, replanContext };
      const jobId = btoa(unescape(encodeURIComponent(JSON.stringify(envelope)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const progress = { phase: "analysis", title: "正在分析您的需求……", items: [
        `✓ 已识别目的地：${profile.city}`,
        `✓ 已识别旅行时长：${profile.days}天${profile.nights}晚`,
        `✓ 出行人数：${profile.partySize}人`,
        `✓ 偏好：${profile.preferences.length ? profile.preferences.join(" / ") : profile.style || "未指定"}`,
        `✓ 必选景点：${profile.requiredAttractions.length ? profile.requiredAttractions.join(" / ") : "未指定"}`,
        `✓ 每日时段：${profile.dayStart === "Unknown" ? "待确认" : profile.dayStart}—${profile.dayEnd === "Unknown" ? "待确认" : profile.dayEnd}`,
        `✓ 需求解析模型：${profile.extractionModel || deepSeekModel(env, "extract")}`,
      ], formSync: profile };
      return json({ jobId, status: "working", progress });
    }

    if (url.pathname === "/api/plan/status") {
      const id = cleanText(url.searchParams.get("id"));
      if (!id) return json({ error: { message: "缺少规划任务 ID" } }, 400);
      let envelope: any;
      try {
        let normalized = id.replace(/-/g, "+").replace(/_/g, "/");
        while (normalized.length % 4) normalized += "=";
        envelope = JSON.parse(decodeURIComponent(escape(atob(normalized))));
      } catch { return json({ status: "error", error: { message: "规划任务无效或已损坏" } }, 400); }
      if (Date.now() - envelope.createdAt > 15 * 60 * 1000) return json({ status: "error", error: { message: "规划任务已过期，请重新生成" } }, 410);
      const cookieKey = `travel_job_${id.slice(0, 16)}`;
      const cookies = request.headers.get("cookie") || "";
      if (!cookies.includes(`${cookieKey}=ready`)) {
        return json({ status: "working", progress: { phase: "live", title: "正在联网获取可验证的旅行数据……", sources: [
          { id: "spots", label: "景点与开放信息", provider: "中文维基百科 / 高德辅助核验", state: "loading" },
          { id: "weather", label: "天气", provider: "Open-Meteo / 已配置天气服务", state: "loading" },
          { id: "routing", label: "路线与交通时间", provider: "高德路线 / OSRM", state: "waiting", detail: "候选坐标返回后计算" },
          { id: "hotels", label: "住宿候选", provider: "酒店服务 / 高德住宿检索", state: "loading" },
          { id: "crowd", label: "拥挤与预约", provider: "官方实时接口", state: "unavailable", detail: "当前未连接" },
          { id: "season", label: "当季景观", provider: "景点页面 / 受控公开信息检索", state: "loading" },
        ], items: [
          `✓ 已通过中国范围地理服务核验目的地：${envelope.city.displayName || envelope.city.name}`,
          `✓ 已锁定硬约束：${envelope.profile.requiredAttractions.length ? envelope.profile.requiredAttractions.join("、") : "未指定必去景点"}`,
          `● 后端已启动天气、景点与酒店并行查询；任一来源失败不会中止其他来源`,
          `● 候选景点返回后将先计算住宿地到景点及景点间交通矩阵`,
          `● 交通矩阵就绪后才调用 ${deepSeekModel(env, "planner")} 生成完整活动时间轴`,
          `● 模型可按需调用受控联网工具补充 Wikimedia 与高德公开实体信息`,
          `● 客流、预约、房价和余房没有可靠返回时保持“暂未核验”`,
        ], formSync: envelope.profile } }, 200, { "set-cookie": `${cookieKey}=ready; Max-Age=900; Path=/; ${url.protocol === "https:" ? "Secure; " : ""}SameSite=Lax` });
      }
      const result = await buildPlan(envelope.profile, envelope.city, env, envelope.replanContext);
      return json({ status: "done", result, progress: result.progress });
    }

    return null;
  } catch (error: any) {
    return json({ error: { message: cleanText(error?.message, "服务暂时不可用") } }, 500);
  }
}

async function buildPlan(profile: any, city: any, env: any, replanContext: any = null) {
  const providerBundle = await settleTravelProviders({
    weather: weatherFor(city, profile.startDate, profile.days),
    spots: wikipediaSpots(city, 48, profile.requiredAttractions, profile.preferences, env),
    hotels: hotelFor(profile, city, env),
  });
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
    if (/商务住宅|购物服务|公司企业|汽车服务|生活服务|医疗保健|大型商场/.test(entityText)) return false;
    if (/片场|摄影棚|摄影基地|总店|旗舰店|购物中心|商场|售楼处|影楼/.test(spot.name)) return false;
    if (/(?:北馆|南馆|东馆|西馆|分馆)$/.test(spot.name) && rawSpots.some((candidate: any) => normalizeName(candidate.name) === normalizeName(spot.name.replace(/(?:北馆|南馆|东馆|西馆|分馆)$/, "")))) return false;
    if (spot.category === "城市景观" && !/风景名胜|公园广场|科教文化|文物古迹|自然地名|特色街区|旅游景点|景区|公园|博物馆|美术馆|纪念馆|故居|遗址|古镇|寺|庙|塔|湖|山|湿地|运河|古街|历史|文化/.test(entityText)) return false;
    if (/暂停开放|永久关闭|停止营业/.test(`${spot.openingHours || ""} ${spot.status || ""}`)) return false;
    if (relatedRequired(spot) && !canonicalRequiredIds.has(spot.id)) return false;
    return true;
  });
  const ranked = rankSpots(uniqueSpots([...required, ...filtered]), profile);
  if (ranked.length < Math.max(profile.days + required.length, 6)) throw new Error(`仅核验到 ${ranked.length} 个有效景点，无法可靠生成 ${profile.days} 天行程`);

  const trafficMatrix = await buildTrafficMatrix(profile, city, ranked);
  const matrixSpotIds = new Set(trafficMatrix.nodes.filter((node: any) => node.id !== "hotel").map((node: any) => node.id));
  const spots = ranked.filter((spot: any) => matrixSpotIds.has(spot.id)).map((spot: any) => requiredNameById.has(spot.id)
    ? { ...spot, name: requiredNameById.get(spot.id), requiredByUser: true, category: "用户必选" }
    : { ...spot, requiredByUser: false });
  const fetchedAt = new Date().toISOString();
  const plannerSpots = spots.map((spot: any) => {
    const canonicalName = cleanText(requiredNameById.get(spot.id), spot.name);
    const tags = [...new Set([spot.category, ...(spot.matchedPreferences || []), ...(/夜|江|湖|河|桥/.test(canonicalName) ? ["夜景"] : []), ...(/园|湖|山|湿地|溪|谷/.test(canonicalName) ? ["自然", "摄影"] : []), ...(/寺|庙|博物馆|遗址|故居|古镇/.test(canonicalName) ? ["文化"] : [])].map(cleanText).filter(Boolean))];
    return {
      id: spot.id, name: canonicalName, officialName: spot.officialName || spot.name, aliases: imageLookupNames(canonicalName, city.name), lat: Number(spot.lat), lng: Number(spot.lng),
      category: spot.category, poiType: spot.category || "旅游景点", cluster: cleanText(spot.district || spot.address, "Unknown"),
      recommendedDurationMin: clamp(spot.durationMin || 120, 60, 240), openingHours: spot.openingHours || null,
      openingStatus: spot.openingHours ? "estimated" : "unknown", reservation: { status: "unknown", note: "未接入景区指定日期官方预约余量" },
      indoor: /博物馆|展览|纪念馆|美术馆/.test(`${spot.name}${spot.category}`) ? true : /山|湖|园|湿地|古镇|街/.test(`${spot.name}${spot.category}`) ? false : null,
      weatherFit: /博物馆|展览|纪念馆|美术馆/.test(`${spot.name}${spot.category}`) ? ["降雨备选"] : ["无强降雨时优先"],
      bestTimes: tags.includes("夜景") ? ["日落后"] : tags.includes("摄影") ? ["上午柔光", "日落前"] : ["开放时段内"],
      seasonFit: { status: "unknown", note: profile.seasonalNeeds?.length ? `用户关注 ${profile.seasonalNeeds.join("、")}；尚无景区官方指定日期状态，不能当作确定盛花/秋色` : "未要求季节限定" },
      tags, requiredByUser: Boolean(spot.requiredByUser), sourceName: spot.sourceName || spot.source || "公开地图 / 中文维基百科",
      sourceUrl: spot.sourceUrl || null, fetchedAt: spot.fetchedAt || fetchedAt,
      sources: [{ name: spot.sourceName || spot.source || "公开地图 / 中文维基百科", url: spot.sourceUrl || null, fetchedAt: spot.fetchedAt || fetchedAt, status: spot.openingHours ? "entity-verified" : "entity-only" }],
      unknown: [!spot.openingHours ? "开放时间" : null, "指定日期预约", "官方实时客流"].filter(Boolean),
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
    dataPolicy: { verified: "仅来自工具返回", prediction: "必须显示 Prediction 与依据", unknown: "不得升级为 Verified" },
  };
  const generated = await generatePlannerDraft(profile, knowledge, env, replanContext);
  const spotsById = new Map(spots.map((spot: any) => [spot.id, requiredNameById.has(spot.id) ? { ...spot, name: requiredNameById.get(spot.id), officialName: spot.officialName || spot.name } : spot]));
  const alternatives: any[] = [];
  const affectedDayIndexes = replanContext ? adjustmentDayIndexes(replanContext.adjustment, profile.days) : [];

  for (let variantIndex = 0; variantIndex < 3; variantIndex += 1) {
    const draftVariant = generated.draft.variants[variantIndex];
    const variantId = ["hot", "niche", "relax"][variantIndex];
    let daysPlan = Array.from({ length: profile.days }, (_, dayIndex) => {
      const draftDay = draftVariant?.days?.[dayIndex] || fallbackPlannerDraft(profile, spots, trafficMatrix, "模型缺少日期").variants[variantIndex].days[dayIndex];
      return planDayFromDraft(draftDay, dayIndex, spotsById, trafficMatrix, weather.tripForecast[dayIndex], profile);
    });
    const missingRequired = required.filter((requiredSpot: any) => !daysPlan.flatMap((day: any) => day.items).some((item: any) => item.id === requiredSpot.id && normalizeName(item.name) === normalizeName(requiredNameById.get(requiredSpot.id) || requiredSpot.name) && item.requiredByUser));
    if (missingRequired.length && !generated.modelAudit.degraded) {
      throw new Error(`确定性编译器拒绝模型草案：${draftVariant?.title || variantId} 缺少 ${missingRequired.map((spot: any) => requiredNameById.get(spot.id) || spot.name).join("、")}`);
    }
    for (const requiredSpot of missingRequired) {
      const targetIndex = Math.max(0, required.findIndex((spot: any) => spot.id === requiredSpot.id)) % profile.days;
      const canonical = spotsById.get(requiredSpot.id) || requiredSpot;
      const rebuilt = scheduleDay(uniqueSpots([canonical, ...daysPlan[targetIndex].items.filter((item: any) => !item.requiredByUser)]).slice(0, 2), profile, targetIndex, weather.tripForecast[targetIndex]);
      rebuilt.degradedConstraintRepair = "DeepSeek 不可用时由确定性降级器恢复缺失的用户必去硬约束";
      daysPlan[targetIndex] = rebuilt;
    }
    if (generated.modelAudit.degraded) {
      const seenRequiredIds = new Set<string>();
      daysPlan = daysPlan.map((day: any, dayIndex: number) => {
        let changed = false;
        const cleanedItems = day.items.flatMap((item: any) => {
          if (!requiredNameById.has(item.id)) return [{ ...item, requiredByUser: false }];
          if (seenRequiredIds.has(item.id)) { changed = true; return []; }
          seenRequiredIds.add(item.id);
          const canonicalName = requiredNameById.get(item.id);
          if (item.name !== canonicalName || !item.requiredByUser) changed = true;
          return [{ ...item, name: canonicalName, requiredByUser: true }];
        });
        if (!changed) return { ...day, items: cleanedItems };
        const rebuilt = scheduleDay(cleanedItems, profile, dayIndex, weather.tripForecast[dayIndex]);
        rebuilt.degradedConstraintRepair = "透明降级器已去除重复必去节点并恢复标准名称";
        return rebuilt;
      });
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
      await enrichDayTransit(day, city);
      day.dining = await Promise.all(day.blocks.filter((block: any) => block.type === "rest" && block.mealType && block.anchor).map((block: any) => diningFor(city.name, block.anchor.lat, block.anchor.lng, block.mealType)));
    }
    const transportEstimate = Math.round(daysPlan.reduce((sum: number, day: any) => sum + Number(day.route?.distance || 0), 0) / 1000 * 2.2);
    alternatives.push({
      id: variantId, city: city.name, cityRef: city, startDate: profile.startDate, days: profile.days, budget: profile.budget,
      style: draftVariant?.style || profile.style, preferences: profile.preferences, pace: profile.pace, variant: variantId, transport: profile.transport,
      title: draftVariant?.title || ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex], strategy: draftVariant?.strategy || "依据候选景点知识包与交通矩阵", weather,
      daysPlan, hotelPlan: hotel,
      budgetBreakdown: { knownEstimate: transportEstimate, limit: profile.budget, items: [{ name: "市内交通透明估算", amount: transportEstimate }, { name: "住宿", amount: hotel.pricedCount ? hotel.candidates?.[0]?.price || null : null }, { name: "门票", amount: null }, { name: "餐饮", amount: null }], note: "只汇总有数据来源的金额；缺失价格保持 Unknown" },
      dataSources: { weather: weather.source || "Unavailable", spots: "中文维基百科 / OSM / 高德 POI", hotels: hotel.candidates?.length ? "高德酒店 POI / 酒店 MCP" : "Unknown", routing: trafficMatrix.source, transit: "高德地图 MCP；不可用时保留 OSRM 矩阵事实", images: "高德官方 / Wikimedia / Unsplash", crowd: "Unknown；节假日风险仅可标记 Prediction", reservations: "Unknown" },
      generatedAt: fetchedAt,
      planningDecision: { model: generated.modelAudit.plannerModel, repairModel: generated.modelAudit.repairModel, repairRounds: generated.modelAudit.repairRounds, formatRepairs: generated.modelAudit.formatRepairs, networkToolCalls: generated.modelAudit.toolCalls, degraded: generated.modelAudit.degraded, degradationReason: generated.modelAudit.degradationReason || null, draftCompilerIssues: generated.modelAudit.compilerIssues },
      changeScope: replanContext && variantId === replanContext.activeVariant ? { mode: affectedDayIndexes.length ? "minimum-disruption" : "global-with-preservation-guidance", affectedDays: affectedDayIndexes.map((index: number) => index + 1), preservedDays: Array.from({ length: profile.days }, (_, index) => index + 1).filter((day) => !affectedDayIndexes.includes(day - 1)), note: "未受影响日期的稳定景点 ID 与原时间由后端锁定，不交给模型重写。" } : null,
    });
  }

  for (const plan of alternatives) {
    plan.evaluation = planEvaluation(plan, profile, spots.length);
    plan.optimization = { algorithm: "DeepSeek V4 Pro 完整时间轴 + 规划前交通矩阵 + Travel Compiler", candidateCount: spots.length, selectedCount: plan.evaluation.evidence.selectedCount, requiredCoverage: `${plan.evaluation.evidence.requiredMatched.length}/${plan.evaluation.evidence.requiredTotal}`, note: "交通矩阵在模型调用前生成；AI 草案经确定性校验，必要时最多两轮修复。" };
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
  const amapVerifiedLegs = transitLegs.filter((block: any) => block.mcpTransport).length;
  const progressItems = [
    `✓ 实际获取候选景点 ${rawSpots.length} 个，过滤后进入知识包 ${spots.length} 个`,
    `✓ 已核验用户必去景点 ${required.length} 个；三套方案均通过覆盖检查`,
    `✓ 已在核心规划前计算交通矩阵 ${trafficMatrix.legs.length} 条有向路线（${trafficMatrix.source}）`,
    `✓ 天气状态：${providerBundle.weather.status === "ready" ? `由 ${weather.source} 返回` : "Unavailable，未套用其他日期"}`,
    `✓ 酒店状态：${hotel.candidates?.length ? `${hotel.candidates.length} 个候选，${hotel.pricedCount || 0} 个带来源参考价` : "Unknown，未生成假酒店或假价格"}`,
    `✓ ${generated.modelAudit.plannerModel} 已生成完整活动时间轴；联网查询工具实际调用 ${generated.modelAudit.toolCalls.length} 次`,
    `✓ Travel Compiler 检出 ${generated.modelAudit.compilerIssues.length} 项并执行 ${generated.modelAudit.repairRounds} 轮 AI 修复`,
    `✓ 高德 MCP 校验 ${amapVerifiedLegs}/${transitLegs.length} 个最终交通段；其余保留矩阵来源`,
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
      { id: "routing", label: "路线与交通时间", provider: trafficMatrix.source, state: trafficMatrix.legs.length ? "success" : "error", detail: `${trafficMatrix.legs.length} 条有向路线` },
      { id: "hotels", label: "住宿候选", provider: hotel.candidates?.length ? "高德地图 / 酒店 MCP" : "未返回", state: hotel.candidates?.length ? "success" : "unavailable", detail: hotel.candidates?.length ? `${hotel.candidates.length} 个候选` : "没有可靠候选" },
      { id: "crowd", label: "拥挤与预约", provider: "未接官方实时接口", state: "unavailable", detail: "保持暂未核验" },
      { id: "season", label: "当季景观", provider: generated.modelAudit.toolCalls.length ? "DeepSeek 联网工具" : "候选知识包", state: "success", detail: generated.modelAudit.toolCalls.length ? `${generated.modelAudit.toolCalls.length} 次受控查询` : "未额外调用搜索" },
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
    planner: { type: "deepseek-v4-constraint-solver-with-server-tools", extractionModel: profile.extractionModel || deepSeekModel(env, "extract"), plannerModel: generated.modelAudit.plannerModel, repairModel: generated.modelAudit.repairModel, thinking: { planner: "enabled", repair: "enabled", hiddenReasoningExposed: false }, network: { enabled: true, implementation: "DeepSeek tool calls -> server-side Wikimedia / 高德查询", actualToolCalls: generated.modelAudit.toolCalls }, trafficMatrix: { readyBeforePlanner: true, source: trafficMatrix.source, legCount: trafficMatrix.legs.length, fetchedAt: trafficMatrix.fetchedAt }, repairRounds: generated.modelAudit.repairRounds, degraded: generated.modelAudit.degraded, stages: ["V4 Flash 需求结构化", "真实数据与联网工具", "规划前交通矩阵", "V4 Pro 完整时间轴", "确定性编译", "V4 Pro 局部修复", "最终核验"] },
    progress,
  };
  assertPlanContract(result);
  return result;
}
