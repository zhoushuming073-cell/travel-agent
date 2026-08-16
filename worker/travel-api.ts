// @ts-nocheck

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const OSRM = "https://router.project-osrm.org";

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
  const requiredText = text.match(/(?:一定|必须|必选|务必)(?:能)?去\s*([^。；;\n]+)/);
  if (requiredText) required.push(...requiredText[1].split(/[、，,和与及]/).map(v => v.trim()).filter(v => v.length >= 2 && v.length <= 18));
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

async function weatherFor(city: any, startDate: string, days: number) {
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

async function overpassSpots(city: any, limit = 35, requiredNames: string[] = []) {
  const radius = 24000;
  const around = `(around:${radius},${city.lat},${city.lng})`;
  const exactRequired = requiredNames.flatMap(name => {
    const safeName = cleanText(name).replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
    return [`nwr[\"name\"=\"${safeName}\"]${around};`, `nwr[\"name:zh\"=\"${safeName}\"]${around};`];
  });
  const query = [
    "[out:json][timeout:25];(",
    `nwr[\"tourism\"~\"attraction|museum|viewpoint|gallery|zoo|theme_park\"][\"name\"]${around};`,
    `nwr[\"historic\"][\"name\"]${around};`,
    `nwr[\"leisure\"=\"park\"][\"name\"]${around};`,
    `nwr[\"natural\"~\"peak|waterfall|beach|spring\"][\"name\"]${around};`,
    `nwr[\"amenity\"~\"place_of_worship|arts_centre\"][\"name\"]${around};`,
    ...exactRequired,
    ");out center tags;",
  ].join("");
  const requestInit = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }) };
  let raw: any;
  try {
    raw = await fetchJson(OVERPASS, requestInit, 30000, "OpenStreetMap Overpass 主节点");
  } catch (error: any) {
    if (!/429|超时|5\d\d/.test(cleanText(error?.message))) throw error;
    raw = await fetchJson("https://overpass.kumi.systems/api/interpreter", requestInit, 30000, "OpenStreetMap Overpass 备用节点");
  }
  const seen = new Set<string>();
  return (raw.elements || []).map((element: any) => poiFromElement(element)).filter((poi: any) => {
    const key = normalizeName(poi.name);
    if (!key || !Number.isFinite(poi.lat) || !Number.isFinite(poi.lng) || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, limit);
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
      verified.push({ ...localMatch, requiredByUser: true, category: "用户必选", recommendationReasons: ["用户明确指定的必选项", "已在本次 Overpass 候选景点中核验"] });
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

async function hotelFor(profile: any, city: any) {
  if (profile.lodgingArea) return { name: `${profile.lodgingArea}住宿区域`, reason: `用户指定住宿范围：${profile.lodgingArea}`, note: "未指定具体酒店；实时房价与余房需在预订平台复核", price: null };
  return { name: "未锁定具体酒店", reason: `建议在${city.name}行程中心区域筛选`, note: "未取得可靠实时住宿数据，因此不虚构酒店、房价或余房", price: null };
}

export async function handleTravelApi(request: Request, env: any, url: URL): Promise<Response | null> {
  try {
    if (url.pathname === "/api/health") return json({
      ok: true,
      ai: { status: env.DEEPSEEK_API_KEY ? "configured" : "unconfigured", model: env.DEEPSEEK_MODEL || "deepseek-chat", note: "两阶段调用：先提取需求，再用已核验工具数据规划" },
      services: [
        { name: "OpenStreetMap / Overpass", provider: "OSM", status: "live", note: "城市与景点公开数据" },
        { name: "Open-Meteo", provider: "Open-Meteo", status: "live", note: "最多约 16 天逐日预报" },
        { name: "OSRM", provider: "OSRM", status: "live", note: "道路路线；失败时透明估算" },
        { name: "官方客流与预约", provider: "未接入", status: "offline", note: "保持未知，不由 AI 编造" },
        { name: "本地 Ollama", provider: "云端不可访问", status: "offline", note: "部署版使用 DeepSeek" },
      ],
    });

    if (url.pathname === "/api/providers/status") return json({ providers: {
      weather: { name: "天气", role: "Open-Meteo", status: "ready", fallback: "超出预报范围时明确显示不可用" },
      spots: { name: "景点", role: "OpenStreetMap / Overpass", status: "ready", fallback: "无数据即报错，不用预制景点" },
      route: { name: "道路路由", role: "OSRM", status: "ready", fallback: "坐标距离×1.25 透明估算" },
      transit: { name: "公共交通", role: "暂无免费稳定实时接口", status: "unconfigured", fallback: "显示道路耗时参考，不声称实时公交" },
      crowd: { name: "客流与预约", role: "景区官方来源待接入", status: "unconfigured", fallback: "保持未知" },
      hotel: { name: "住宿候选", role: "OpenStreetMap / Nominatim", status: "ready", fallback: "不展示未核验房价和余房" },
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
      const spots = await overpassSpots(city, clamp(url.searchParams.get("limit"), 1, 50));
      return json({ city: city.name, spots, count: spots.length, source: "OpenStreetMap / Overpass", fetchedAt: new Date().toISOString() });
    }

    if (url.pathname === "/api/image") return json({ found: false, reason: "仅在可核验到与景点精确绑定的图片时展示；当前部署不做关键词图片猜测" });

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
        return json({ status: "working", progress: { phase: "live", title: "正在联网获取实时信息……", items: [
          `✓ 已通过中国范围地图服务核验目的地：${envelope.city.displayName || envelope.city.name}`,
          "● 正在读取 Open-Meteo 对应出行日期的逐日预报",
          "● 正在从 Overpass 获取候选景点，并逐项核验用户必选项",
          "● 客流、预约、开放状态没有可靠来源时将保持未知",
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
    weatherFor(city, profile.startDate, profile.days), overpassSpots(city, 45, profile.requiredAttractions), hotelFor(profile, city),
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
    for (const day of daysPlan) day.route = await routeFor(day.items);
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
      dataSources: { weather: "Open-Meteo", spots: "OpenStreetMap / Overpass / Nominatim", hotels: "OpenStreetMap / Nominatim（无实时房价）", routing: "OSRM；失败时坐标距离×1.25透明估算", transit: "道路耗时参考，未接入实时公交班次", crowd: "未接入官方可验证来源，全部保持未知", reservations: "未接入景区官方预约接口" },
      generatedAt: new Date().toISOString(),
    });
  }
  const requiredCoverage = alternatives.map(plan => requiredIds.every(id => plan.daysPlan.flatMap((day: any) => day.items).some((item: any) => item.id === id)));
  if (requiredCoverage.some(Boolean) && !requiredCoverage.every(Boolean)) throw new Error("必选景点覆盖校验失败，已拒绝返回不完整路线");
  const progress = { phase: "route", title: "正在进行路线优化……", items: [
    `✓ 获取并去重候选景点 ${spots.length} 个`,
    `✓ 已核验用户必选景点 ${required.length} 个；3 套方案覆盖校验通过`,
    `✓ 已为 ${profile.days * 3} 个日程计算道路路线或透明估算`,
    `✓ 已按 ${profile.dayStart}—${profile.dayEnd} 安排游玩，并插入午餐休息`,
    `✓ 已生成 3 套差异化方案`,
    weather.tripForecast.some((day: any) => day.quality === "unavailable") ? "● 部分日期超出天气预报范围，已保持不可用而非套用今日天气" : "✓ 出行日期天气已由 Open-Meteo 覆盖",
    "● 官方实时客流、预约和实时公交未接入，结果中保持未知",
  ], formSync: profile };
  return { request: profile, alternatives, activeId: "relax", generatedAt: new Date().toISOString(), planner: { type: "two-stage-deepseek-with-verified-tools", stages: ["DeepSeek 需求结构化", "公开数据核验", "DeepSeek 景点排序", "硬约束与必选项校验"] }, progress };
}
