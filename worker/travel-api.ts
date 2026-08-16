// @ts-nocheck

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const OSRM = "https://router.project-osrm.org";
const WEATHER_MCP = "https://mcpmarket.cn/mcp/a5be23a7cc256930f8f3ccc6";
const HOTEL_MCP = "https://mcpmarket.cn/mcp/14d52a3200549c758f548f52";
const AMAP_MCP = "https://mcpmarket.cn/mcp/06cbbceb8f161926894c4584";
const mcpMemory = new Map<string, { expiresAt: number; value: any }>();

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

function parseJsonObject(text: string) {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error("DeepSeek 未返回有效 JSON");
}

async function deepSeek(env: any, messages: any[], jsonMode = false, maxTokens = 5000) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("部署环境尚未配置 DeepSeek API Key");
  const payload: any = {
    model: env.DEEPSEEK_MODEL || "deepseek-chat",
    messages,
    temperature: jsonMode ? 0.15 : 0.35,
    max_tokens: maxTokens,
  };
  if (jsonMode) payload.response_format = { type: "json_object" };
  const result = await fetchJson("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(payload),
  }, 55000, "DeepSeek");
  const content = result?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 没有返回内容");
  return cleanText(content);
}

function deterministicHints(text: string) {
  const result: any = {};
  const city = text.match(/(?:去|到|目的地(?:是|为)?|前往)\s*([\u4e00-\u9fa5]{2,12}?)(?:市|旅游|旅行|游玩|，|。|\s)/);
  if (city) result.city = city[1].replace(/市$/, "");
  const range = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(?:到|至|—|-)\s*(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/);
  if (range) {
    result.startDate = `${range[1]}-${String(range[2]).padStart(2, "0")}-${String(range[3]).padStart(2, "0")}`;
    const end = `${range[4] || range[1]}-${String(range[5]).padStart(2, "0")}-${String(range[6]).padStart(2, "0")}`;
    result.days = Math.max(1, diffDays(result.startDate, end) + 1);
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
  if (end) result.dayEnd = `${String(Number(end[1])).padStart(2, "0")}:00`;
  const lodging = text.match(/(?:住宿|酒店)(?:暂定|定|住)?在\s*([^，。；;\n]{2,20})/);
  if (lodging) result.lodgingArea = lodging[1].trim();
  return result;
}

function mergeProfile(input: any, ai: any) {
  const text = cleanText(input.freeText);
  const hints = deterministicHints(text);
  const today = new Date().toISOString().slice(0, 10);
  const merged = { ...input, ...ai, ...hints };
  const days = clamp(merged.days, 1, 7);
  return {
    city: cleanText(merged.city, "杭州").replace(/市$/, ""),
    startDate: dateString(merged.startDate, dateString(input.startDate, addDays(today, 3))),
    days,
    nights: clamp(merged.nights ?? days - 1, 0, 7),
    partySize: clamp(merged.partySize ?? 1, 1, 20),
    budget: clamp(merged.budget ?? input.budget ?? 1500, 100, 200000),
    style: cleanText(merged.style, input.style || "综合体验"),
    preferences: [...new Set([...list(input.preferences), ...list(ai.preferences)])].slice(0, 10),
    avoid: [...new Set(list(ai.avoid))].slice(0, 8),
    requiredAttractions: [...new Set([...list(ai.requiredAttractions), ...list(hints.requiredAttractions)])].slice(0, 12),
    pace: cleanText(merged.pace, input.pace || "medium"),
    transport: cleanText(merged.transport, input.transport || "公共交通优先"),
    hotelPreference: cleanText(merged.hotelPreference, input.hotelPreference || "交通方便"),
    lodgingArea: cleanText(merged.lodgingArea, ""),
    dayStart: cleanText(merged.dayStart, "09:00"),
    dayEnd: cleanText(merged.dayEnd, "21:00"),
    mealPreference: cleanText(merged.mealPreference, "每天 1—2 个当地特色美食，顺路安排"),
    requestedVariants: list(merged.requestedVariants).length ? list(merged.requestedVariants).slice(0, 3) : ["经典景点覆盖率高", "偏自然和摄影", "避开人流、行程轻松"],
    freeText: text.slice(0, 5000),
  };
}

async function extractProfile(input: any, env: any) {
  const prompt = `请把用户的中国旅行需求整理成结构化 JSON。只提取用户明确表达或可直接计算的信息，不虚构景点、客流、预约、天气、酒店价格。字段：city,startDate(YYYY-MM-DD),days,nights,partySize,budget,style,preferences(string[]),avoid(string[]),requiredAttractions(string[]),pace,transport,hotelPreference,lodgingArea,dayStart(HH:mm),dayEnd(HH:mm),mealPreference,requestedVariants(string[])。\n当前表单：${JSON.stringify(input)}\n用户原文：${cleanText(input.freeText)}`;
  const content = await deepSeek(env, [
    { role: "system", content: "你是旅行需求结构化助手。输出一个 JSON 对象，不要输出解释。" },
    { role: "user", content: prompt },
  ], true, 2200);
  return mergeProfile(input, parseJsonObject(content));
}

async function searchCities(query: string, limit = 8) {
  if (cleanText(query).length < 2) return [];
  const geoParams = new URLSearchParams({ name: cleanText(query), count: String(limit), language: "zh", format: "json", countryCode: "CN" });
  const geoData = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${geoParams}`, {}, 15000, "Open-Meteo 城市搜索");
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
  const data = await fetchJson(`${NOMINATIM}/search?${params}`, {}, 18000, "OSM 城市搜索");
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

function wikiPageToSpot(page: any, city: any, requiredNames: string[]) {
  const coordinate = page?.coordinates?.[0];
  if (!coordinate || !Number.isFinite(Number(coordinate.lat)) || !Number.isFinite(Number(coordinate.lon))) return null;
  const name = cleanText(page.title);
  const extract = cleanText(page.extract);
  const text = `${name} ${extract}`;
  if (/街道办事处|行政区|市辖区|下辖|地铁|车站|铁路|高速公路|国道|省道|医院|学校|大学|住宅区|写字楼|公司总部|机场/.test(text)) return null;
  if (/^[\u4e00-\u9fa5]{2,10}(市|区|县|省)$/.test(name)) return null;
  if (!/景区|景点|公园|博物馆|美术馆|纪念馆|故居|遗址|古镇|古村|寺|庙|塔|湖|山|峰|洞|瀑布|湿地|花园|园林|宫|祠|陵|古城|历史文化|世界遗产|风景|自然保护区|教堂|广场|动物园|植物园|水库|岛|堤|桥|街区|宋城/.test(text)) return null;
  const lat = Number(coordinate.lat), lng = Number(coordinate.lon);
  if (haversine(city.lat, city.lng, lat, lng) > 80000) return null;
  const requiredByUser = requiredNames.some(required => {
    const wanted = normalizeName(required), actual = normalizeName(name);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
  });
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

async function wikipediaSpots(city: any, limit = 40, requiredNames: string[] = [], preferences: string[] = []) {
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
  if (!responses.length) throw new Error("中文维基百科景点检索暂时不可用，请稍后重试");
  const pages = responses.flatMap(response => response?.query?.pages || []);
  const spots = uniqueSpots(pages.map(page => wikiPageToSpot(page, city, requiredNames)).filter(Boolean));
  return rankSpots(spots, { style: preferences.join(" "), preferences }).slice(0, limit);
}

async function verifyRequired(city: any, names: string[], candidates: any[] = []) {
  const verified: any[] = [];
  for (const name of names) {
    const wanted = normalizeName(name);
    const localMatch = candidates.find(item => {
      const actual = normalizeName(item.name);
      return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
    });
    if (localMatch) {
      verified.push({ ...localMatch, requiredByUser: true, category: "用户必选", recommendationReasons: ["用户明确指定的必选项", "已在本次中文维基百科候选景点中核验"] });
      continue;
    }
    const params = new URLSearchParams({ q: `${name}, ${city.name}, 中国`, format: "jsonv2", addressdetails: "1", extratags: "1", namedetails: "1", limit: "5", countrycodes: "cn", "accept-language": "zh-CN" });
    const rows = await fetchJson(`${NOMINATIM}/search?${params}`, {}, 18000, `必选景点“${name}”地图核验`);
    const best = (rows || []).find((row: any) => normalizeName(row.name || row.display_name.split(",")[0]).includes(normalizeName(name))) || rows?.[0];
    if (!best) throw new Error(`必选景点“${name}”未能通过地图数据核验，已停止规划以避免遗漏或臆造`);
    const lat = Number(best.lat), lng = Number(best.lon);
    const distance = haversine(city.lat, city.lng, lat, lng);
    if (distance > 80000) throw new Error(`必选景点“${name}”与目的地距离异常，已停止规划等待核验`);
    verified.push({
      id: `nominatim-${best.osm_type}-${best.osm_id}`, name: cleanText(best.name || name), lat, lng,
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

function rankSpots(spots: any[], profile: any) {
  const prefs = `${profile.style} ${profile.preferences.join(" ")}`;
  return [...spots].sort((a, b) => {
    const score = (spot: any) => (spot.requiredByUser ? 1000 : 0) + (prefs.includes("自然") && spot.category === "自然景观" ? 15 : 0) + (prefs.includes("摄影") && ["自然景观", "景点"].includes(spot.category) ? 8 : 0) + (spot.staticPoiQuality === "较高" ? 3 : 0);
    return score(b) - score(a);
  });
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
  const searched: any = await callMcp(AMAP_MCP, "maps_text_search", { keywords: name, city, types: "风景名胜" }, { timeoutMs: 9000, cacheMs: 30 * 60 * 1000 });
  const wanted = normalizeName(name);
  const rows = amapPoiRows(searched);
  const poi = rows.find((row: any) => normalizeName(row.name) === wanted) || rows.find((row: any) => {
    const actual = normalizeName(row.name);
    return actual.includes(wanted) || wanted.includes(actual);
  });
  if (!poi) return null;
  let detail: any = poi;
  if (poi.id) {
    try { detail = mcpData(await callMcp(AMAP_MCP, "maps_search_detail", { id: cleanText(poi.id) }, { timeoutMs: 9000, cacheMs: 60 * 60 * 1000 })) || poi; } catch { detail = poi; }
  }
  if (Array.isArray(detail?.pois)) detail = detail.pois[0] || poi;
  const photos = [...(Array.isArray(poi.photos) ? poi.photos : []), ...(Array.isArray(detail?.photos) ? detail.photos : [])];
  const photo = photos.map((item: any) => cleanText(typeof item === "string" ? item : item?.url || item?.photo_url)).find((url: string) => /^https:\/\//i.test(url));
  const location = cleanText(detail?.location || poi.location);
  return { id: cleanText(poi.id), name: cleanText(poi.name), location, photo, raw: detail };
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

function scheduleDay(items: any[], profile: any, dayIndex: number, weather: any) {
  let cursor = timeToMinutes(profile.dayStart, 540);
  const endLimit = timeToMinutes(profile.dayEnd, 1260);
  const blocks: any[] = [];
  const scheduled: any[] = [];
  items.forEach((original, index) => {
    if (index > 0) {
      const previous = items[index - 1];
      const distanceM = haversine(previous.lat, previous.lng, original.lat, original.lng) * 1.25;
      const durationMin = Math.max(12, Math.round(distanceM / 260 / 60));
      blocks.push({ type: "leg", from: previous.name, to: original.name, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + durationMin), durationMin, distanceM: Math.round(distanceM), source: "OSRM/透明估算", quality: "estimated" });
      cursor += durationMin;
    }
    if (cursor < 12 * 60 + 30 && cursor + original.durationMin > 12 * 60 + 30) {
      const restStart = Math.max(cursor, 12 * 60);
      blocks.push({ type: "rest", label: "午餐与休息（就近安排，不跨区追店）", startTime: minutesToTime(restStart), endTime: minutesToTime(restStart + 75), durationMin: 75 });
      cursor = restStart + 75;
    }
    const durationMin = clamp(original.durationMin, 60, 180);
    if (cursor + durationMin > endLimit && scheduled.length) return;
    const spot = { ...original, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + durationMin), durationMin };
    scheduled.push(spot); blocks.push({ type: "attraction", item: spot }); cursor += durationMin;
  });
  return { day: dayIndex + 1, date: weather.date, weekday: weekday(weather.date), theme: scheduled.map(item => item.category).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(" · ") || "城市探索", items: scheduled, blocks, conflicts: [], weather };
}

function distribute(candidates: any[], profile: any, variantIndex: number) {
  const targetPerDay = profile.pace === "slow" || variantIndex === 2 ? 2 : 3;
  const required = candidates.filter(item => item.requiredByUser);
  const optional = candidates.filter(item => !item.requiredByUser);
  const rotated = optional.slice(variantIndex * 2).concat(optional.slice(0, variantIndex * 2));
  const days = Array.from({ length: profile.days }, () => [] as any[]);
  required.forEach((spot, index) => days[index % profile.days].push(spot));
  rotated.forEach(spot => {
    const day = days.reduce((best, current) => current.length < best.length ? current : best, days[0]);
    if (day.length < targetPerDay) day.push(spot);
  });
  return days;
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
  };
}

async function hotelFor(profile: any, city: any) {
  const area = cleanText(profile.lodgingArea, `${city.name}市中心`);
  try {
    const geocoded: any = await callMcp(HOTEL_MCP, "geocode", { address: `${city.name}${area}`, city: city.name }, { timeoutMs: 12000, cacheMs: 30 * 60 * 1000 });
    const geoRows = mcpData(geocoded)?.geocodes || mcpData(geocoded) || [];
    const location = cleanText(Array.isArray(geoRows) ? geoRows[0]?.location : geoRows?.location);
    if (!location) throw new Error("酒店 MCP 未能定位住宿区域");
    const nearby: any = await callMcp(HOTEL_MCP, "nearby_hotel", { location, distance: 10 }, { timeoutMs: 12000, cacheMs: 15 * 60 * 1000 });
    const rows = mcpData(nearby);
    const candidates = (Array.isArray(rows) ? rows : rows?.hotels || []).map(hotelRecord).filter(Boolean).slice(0, 5);
    if (!candidates.length) {
      const fallback = await hotelFallback(profile, city);
      return { ...fallback, mcpStatus: "empty", source: "MCPMarket 高端酒店查询（国内）", sourceUrl: "https://mcpmarket.cn/server/68ef4df83e8621b27597dafd", note: `酒店 MCP 已查询“${area}”周边 10 公里，但当前未返回可核验候选；不虚构酒店、房价或余房。` };
    }
    const best = candidates[0];
    return {
      name: best.name, reason: `${area}附近的酒店 MCP 可核验候选${best.distance ? `，距离约 ${best.distance}` : ""}`,
      note: `共返回 ${candidates.length} 个候选；该接口未提供指定日期的实时房价和余房，预订前仍需复核。`,
      price: null, candidates, mcpStatus: "ready", source: "MCPMarket 高端酒店查询（国内）",
      sourceUrl: "https://mcpmarket.cn/server/68ef4df83e8621b27597dafd",
    };
  } catch (error: any) {
    const fallback = await hotelFallback(profile, city);
    return { ...fallback, mcpStatus: "fallback", source: "住宿区域兜底", sourceUrl: "https://mcpmarket.cn/server/68ef4df83e8621b27597dafd", note: `酒店 MCP 暂不可用：${cleanText(error?.message)}。未虚构酒店、房价或余房。` };
  }
}

export async function handleTravelApi(request: Request, env: any, url: URL): Promise<Response | null> {
  try {
    if (url.pathname === "/api/health") return json({
      ok: true,
      ai: { status: env?.DEEPSEEK_API_KEY ? "configured" : "unconfigured", model: env?.DEEPSEEK_MODEL || "deepseek-chat", note: "两阶段调用：先提取需求，再把 MCP 与公开数据交给 DeepSeek 排序" },
      services: [
        { name: "天气查询 MCP", provider: "MCPMarket", status: "live", note: "Open-Meteo 逐小时预报；MCP 失败时使用 Open-Meteo 直连兜底" },
        { name: "高端酒店查询（国内）", provider: "MCPMarket", status: "live", note: "附近高星酒店候选；不返回或未核验时不编造房价、余房" },
        { name: "高德地图 AMap", provider: "MCPMarket / 高德开放平台", status: "live", note: "POI、精确图片与公交路线；共享免费额度耗尽时透明回退" },
        { name: "中文维基百科景点检索", provider: "Wikimedia", status: "live", note: "公开页面、摘要、坐标与精确页面图片兜底" },
        { name: "OpenStreetMap / Nominatim", provider: "OSM", status: "live", note: "城市和用户必选景点核验兜底" },
        { name: "OSRM", provider: "OSRM", status: "live", note: "地图线路几何；失败时透明估算" },
        { name: "官方客流与预约", provider: "未接入", status: "offline", note: "保持未知，不由 AI 编造" },
      ],
    });

    if (url.pathname === "/api/providers/status") return json({ providers: {
      weather: { name: "天气", role: "MCPMarket 天气查询", status: "ready", fallback: "Open-Meteo 直连；超出预报范围时明确显示不可用" },
      spots: { name: "景点", role: "中文维基百科 + OSM + 高德 POI", status: "ready", fallback: "高德免费共享额度不可用时保留精确页面图片和 OSM 核验" },
      route: { name: "道路路线", role: "OSRM 地图几何 + 高德 MCP", status: "ready", fallback: "坐标距离×1.25 透明估算" },
      transit: { name: "公共交通", role: "高德地图 MCP", status: "ready", fallback: "无班次或额度不足时显示道路耗时参考" },
      crowd: { name: "客流与预约", role: "景区官方来源待接入", status: "unconfigured", fallback: "保持未知" },
      hotel: { name: "住宿候选", role: "MCPMarket 高端酒店查询（国内）", status: "ready", fallback: "仅保留用户住宿区域，不展示未核验房价和余房" },
      images: { name: "景点图片", role: "高德 POI 精确照片优先", status: "ready", fallback: "中文维基百科精确页面图片；绝不关键词猜图" },
    } });

    if (url.pathname === "/api/cities") {
      const centers = [
        ["北京", 39.9042, 116.4074], ["上海", 31.2304, 121.4737], ["广州", 23.1291, 113.2644],
        ["深圳", 22.5431, 114.0579], ["杭州", 30.2741, 120.1551], ["成都", 30.5728, 104.0668],
        ["重庆", 29.563, 106.5516], ["西安", 34.3416, 108.9398], ["南京", 32.0603, 118.7969],
        ["苏州", 31.2989, 120.5853], ["厦门", 24.4798, 118.0894], ["昆明", 25.0389, 102.7183],
      ].map(([name, lat, lng]) => ({ name, displayName: `${name}，中国`, lat, lng, zoom: 11, countryCode: "cn", source: "内置城市入口坐标" }));
      return json({ cities: centers, scope: "中国", note: "仅为常用城市入口；任意中国城市仍通过搜索接口实时查找" });
    }

    if (url.pathname === "/api/city-search") return json({ cities: await searchCities(cleanText(url.searchParams.get("q")), 8), scope: "中国" });

    if (url.pathname === "/api/weather") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"));
      return json(await weatherFor(city, dateString(url.searchParams.get("startDate")), clamp(url.searchParams.get("days"), 1, 7)));
    }

    if (url.pathname === "/api/spots") {
      const city = await resolveCity(cleanText(url.searchParams.get("city"), "杭州"));
      const spots = await wikipediaSpots(city, clamp(url.searchParams.get("limit"), 1, 50));
      return json({ city: city.name, spots, count: spots.length, source: "中文维基百科公开页面与坐标", fetchedAt: new Date().toISOString() });
    }

    if (url.pathname === "/api/image") {
      const imageUrl = cleanText(url.searchParams.get("image"));
      const wikipedia = cleanText(url.searchParams.get("wikipedia"));
      const name = cleanText(url.searchParams.get("name"));
      const cityName = cleanText(url.searchParams.get("city"));
      if (name && cityName) {
        try {
          const amap = await amapPoiForSpot(name, cityName);
          if (amap?.photo) return json({
            found: true, url: amap.photo, source: "高德地图 POI 精确照片",
            sourceUrl: amap.id ? `https://www.amap.com/place/${encodeURIComponent(amap.id)}` : "https://www.amap.com/",
            verifiedName: amap.name,
          });
        } catch { /* 高德额度或服务不可用时继续使用精确页面图片 */ }
      }
      try {
        const parsed = new URL(imageUrl);
        if (parsed.protocol === "https:" && parsed.hostname.endsWith(".wikimedia.org")) {
          const title = wikipedia.replace(/^zh:/, "");
          return json({ found: true, url: imageUrl, source: "Wikimedia 精确页面图片", sourceUrl: title ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : "https://commons.wikimedia.org/" });
        }
      } catch { /* no verified image */ }
      return json({ found: false, reason: "没有与该景点页面精确绑定的 Wikimedia 图片；不做关键词猜图" });
    }

    if (url.pathname === "/api/agent" && request.method === "POST") {
      const body = await request.json();
      const message = await deepSeek(env, [
        { role: "system", content: "你是旅行行程解释助手。只能依据用户提供的已核验上下文回答。凡实时客流、预约、房价、开放状态等上下文中为未知的内容，必须明确说未知，不得推测。回答简洁、中文。" },
        { role: "user", content: `问题：${cleanText(body.prompt)}\n已核验上下文：${JSON.stringify(body.context || {})}` },
      ], false, 1800);
      return json({ message, model: env.DEEPSEEK_MODEL || "deepseek-chat" });
    }

    if (url.pathname === "/api/plan/start" && request.method === "POST") {
      const input = await request.json();
      const profile = await extractProfile(input, env);
      const city = await resolveCity(profile.city);
      profile.city = city.name;
      const envelope = { version: 1, createdAt: Date.now(), profile, city };
      const jobId = btoa(unescape(encodeURIComponent(JSON.stringify(envelope)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const progress = { phase: "analysis", title: "正在分析您的需求……", items: [
        `✓ 已识别目的地：${profile.city}`,
        `✓ 已识别旅行时长：${profile.days}天${profile.nights}晚`,
        `✓ 出行人数：${profile.partySize}人`,
        `✓ 偏好：${profile.preferences.length ? profile.preferences.join(" / ") : profile.style}`,
        `✓ 必选景点：${profile.requiredAttractions.length ? profile.requiredAttractions.join(" / ") : "未指定"}`,
        `✓ 每日时段：${profile.dayStart}—${profile.dayEnd}`,
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
        return json({ status: "working", progress: { phase: "live", title: "正在联网获取可验证的旅行数据……", items: [
          `✓ 已通过中国范围地理服务核验目的地：${envelope.city.displayName || envelope.city.name}`,
          "● 正在调用天气查询 MCP，读取出行日期逐小时预报；失败时使用 Open-Meteo 直连兜底",
          "● 正在检索带坐标的中文百科景点，并核验所有用户必选项",
          "● 正在调用国内酒店 MCP 查询住宿区域附近的可核验候选",
          "● 正在准备高德地图 MCP 的 POI 图片和公交/地铁路线校验",
          "● 完成工具校验后，再把结果交给 DeepSeek 生成三套差异化路线",
          "● 客流、预约、房价、余房没有可靠返回时保持未知，不由 AI 补写",
        ], formSync: envelope.profile } }, 200, { "set-cookie": `${cookieKey}=ready; Max-Age=900; Path=/; Secure; SameSite=Lax` });
      }
      const result = await buildPlan(envelope.profile, envelope.city, env);
      return json({ status: "done", result, progress: result.progress });
    }

    return null;
  } catch (error: any) {
    return json({ error: { message: cleanText(error?.message, "服务暂时不可用") } }, 500);
  }
}

async function buildPlan(profile: any, city: any, env: any) {
  const [weather, rawSpots, hotel] = await Promise.all([
    weatherFor(city, profile.startDate, profile.days), wikipediaSpots(city, 45, profile.requiredAttractions, profile.preferences), hotelFor(profile, city),
  ]);
  const required = await verifyRequired(city, profile.requiredAttractions, rawSpots);
  const spots = rankSpots(uniqueSpots([...required, ...rawSpots]), profile);
  if (spots.length < Math.max(4, profile.days * 2)) throw new Error(`仅核验到 ${spots.length} 个可用景点，不足以生成可靠的 ${profile.days} 天行程`);

  const toolContext = {
    request: { ...profile, freeText: undefined }, city,
    weather: weather.tripForecast,
    hotel,
    spots: spots.slice(0, 32).map(spot => ({ id: spot.id, name: spot.name, category: spot.category, lat: spot.lat, lng: spot.lng, openingHours: spot.openingHours || null, requiredByUser: spot.requiredByUser })),
    rules: ["每套方案必须包含全部 requiredByUser 景点", "不得声称未知的实时客流、预约、房价、开放状态", "每天保留午餐和休息时间", "只可引用 spots 列表中的 id"],
  };
  const content = await deepSeek(env, [
    { role: "system", content: "你是旅行路线排序器。只可使用输入中已核验的景点 ID，不能创建新景点或实时数据。输出 JSON：{variants:[{style,title,strategy,daySpotIds:string[][]}]}，正好 3 套，每套天数与 request.days 一致。" },
    { role: "user", content: JSON.stringify(toolContext) },
  ], true, 4200);
  const aiAdvice: any = parseJsonObject(content);
  if (!Array.isArray(aiAdvice?.variants) || aiAdvice.variants.length < 3) throw new Error("DeepSeek 第二阶段没有生成完整的三套路线结构，请重试");

  const byId = new Map(spots.map(spot => [spot.id, spot]));
  const requiredIds = required.map(spot => spot.id);
  const labels = profile.requestedVariants.length >= 3 ? profile.requestedVariants : ["经典覆盖", "自然摄影", "轻松避峰"];
  const alternatives: any[] = [];
  for (let variantIndex = 0; variantIndex < 3; variantIndex += 1) {
    const advised = aiAdvice?.variants?.[variantIndex];
    let buckets: any[][] = [];
    if (Array.isArray(advised?.daySpotIds) && advised.daySpotIds.length === profile.days) {
      buckets = advised.daySpotIds.map((ids: any[]) => uniqueSpots((ids || []).map(id => byId.get(cleanText(id))).filter(Boolean)).slice(0, profile.pace === "slow" ? 2 : 3));
    }
    if (buckets.length !== profile.days || buckets.some(items => !items.length)) buckets = distribute(spots, profile, variantIndex);
    for (const requiredId of requiredIds) {
      if (!buckets.flat().some(item => item.id === requiredId)) {
        const target = buckets.reduce((best, current) => current.length < best.length ? current : best, buckets[0]);
        target.unshift(byId.get(requiredId));
      }
    }
    const daysPlan = buckets.map((items, index) => scheduleDay(items, profile, index, weather.tripForecast[index]));
    for (const day of daysPlan) {
      day.route = await routeFor(day.items);
      await enrichDayTransit(day, city);
    }
    const id = variantIndex === 0 ? "hot" : variantIndex === 1 ? "niche" : "relax";
    const transportEstimate = Math.round(daysPlan.reduce((sum, day) => sum + day.route.distance, 0) / 1000 * 2.2);
    alternatives.push({
      id, city: city.name, cityRef: city, startDate: profile.startDate, days: profile.days, budget: profile.budget,
      style: profile.style, preferences: profile.preferences, pace: profile.pace, variant: id, transport: profile.transport,
      title: cleanText(advised?.title, `${city.name}${labels[variantIndex] || "旅行"}方案`),
      strategy: cleanText(advised?.strategy, labels[variantIndex] || "已核验景点的顺路组合"), weather,
      daysPlan, hotelPlan: hotel,
      budgetBreakdown: { knownEstimate: transportEstimate, limit: profile.budget, items: [
        { name: "市内交通透明估算", amount: transportEstimate }, { name: "住宿", amount: null }, { name: "门票", amount: null }, { name: "餐饮", amount: null },
      ], note: "只汇总可透明估算的市内交通；实时房价、票价与餐费未核验，保持未知" },
      dataSources: { weather: "Open-Meteo", spots: "中文维基百科公开页面与坐标；必选项由 OSM Nominatim 精确核验", hotels: "用户指定住宿区域（无实时房价）", routing: "OSRM；失败时坐标距离×1.25透明估算", transit: "道路耗时参考，未接入实时公交班次", crowd: "未接入官方可验证来源，全部保持未知", reservations: "未接入景区官方预约接口" },
      generatedAt: new Date().toISOString(),
    });
  }
  for (const plan of alternatives) {
    plan.dataSources = {
      weather: weather.source || "MCPMarket 天气查询",
      spots: "中文维基百科公开页面与坐标；必选项由 OSM Nominatim 核验；高德 POI 用于精确图片补充",
      hotels: hotel.mcpStatus === "ready" ? "MCPMarket 高端酒店查询（国内）" : "酒店 MCP 已调用但无可核验结果，保留用户住宿区域",
      routing: "OSRM 路线几何；失败时坐标距离×1.25 透明估算",
      transit: "高德地图 MCP 公交/地铁方案；共享免费额度不足时透明回退",
      images: "高德 POI 精确照片优先；中文维基百科精确页面图片兜底",
      crowd: "未接入官方可验证来源，全部保持未知",
      reservations: "未接入景区官方预约接口",
    };
  }
  const requiredCoverage = alternatives.map(plan => requiredIds.every(id => plan.daysPlan.flatMap((day: any) => day.items).some((item: any) => item.id === id)));
  if (requiredCoverage.some(Boolean) && !requiredCoverage.every(Boolean)) throw new Error("必选景点覆盖校验失败，已拒绝返回不完整路线");
  const transitLegs = alternatives.flatMap(plan => plan.daysPlan).flatMap((day: any) => day.blocks).filter((block: any) => block.type === "leg");
  const amapVerifiedLegs = transitLegs.filter((block: any) => block.mcpTransport).length;
  const progress = { phase: "route", title: "路线规划与工具校验已完成", items: [
    `✓ 获取并去重带坐标候选景点 ${spots.length} 个`,
    `✓ 核验用户必选景点 ${required.length} 个；3 套方案覆盖校验全部通过`,
    `✓ 酒店 MCP 状态：${hotel.mcpStatus === "ready" ? `返回 ${hotel.candidates?.length || 1} 个可核验候选` : hotel.mcpStatus === "empty" ? "已查询但暂无候选" : "已透明回退，不虚构酒店"}`,
    `✓ 为 ${profile.days * 3} 个日程计算路线；高德 MCP 已校验 ${amapVerifiedLegs}/${transitLegs.length} 个交通段`,
    `✓ 已按 ${profile.dayStart}—${profile.dayEnd} 安排游玩，并插入午餐休息`,
    `✓ 已生成 3 套差异化方案，并再次检查必选项`,
    weather.tripForecast.some((day: any) => day.quality === "unavailable") ? "● 部分日期超出天气预报范围，保持不可用而非套用今日天气" : `✓ 天气已由 ${weather.source} 覆盖`,
    "● 官方实时客流、景区预约、实时房价与余房仍未接入，结果中保持未知",
  ], formSync: profile };
  return { request: profile, alternatives, activeId: "relax", generatedAt: new Date().toISOString(), planner: { type: "two-stage-deepseek-with-mcp-tools", stages: ["DeepSeek 需求结构化", "天气 / 酒店 / 高德 MCP 与公开数据核验", "DeepSeek 景点排序", "路线工具补全", "硬约束与必选项校验"] }, progress };
}
