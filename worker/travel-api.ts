// @ts-nocheck

import { assertPlanContract } from "./domain/contract.ts";
import { aiRequestInterval, isAiRateLimited, isDurableAiWait, requestWithAiThrottle } from "./domain/ai-throttle.ts";
import { acquireAiRequestSlot, blockAiRequests } from "./persistence.ts";
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
  aiProviderLabel,
  AI_RATE_LIMIT_COOLDOWN_MS,
  classifyAiFailure,
  closeModelCircuit,
  modelFamily,
  modelCircuitState,
  openModelCircuit,
  type AiPurpose,
} from "./domain/model-routing.ts";
import {
  createAdaptiveResearchBudget,
  extendResearchBudget,
  researchUtility,
  shouldContinueResearch,
  spendResearchBudget,
} from "./domain/research-budget.ts";
import {
  deduplicateEvidence,
  researchMetrics,
  scoreResearchEvidence,
  synthesizeFact,
} from "./domain/research-evidence.ts";
import {
  applyFactsToGaps,
  buildResearchGapMap,
  deterministicResearchRequests,
  normalizeAiResearchRequests,
  skippedResearchItems,
} from "./domain/research-planner.ts";
import { FACT_FRESHNESS_POLICIES, FACT_POLICY_VERSION, sourceFitFor, sourceFreshness } from "./domain/research-policy.ts";
import {
  SearchOrchestrator,
  classifySourceTier,
  detectPageAccessStatus,
  sanitizeUntrustedPage,
} from "./domain/search-orchestrator.ts";
import type {
  PageAccessStatus,
  ResearchEvidence,
  ResearchQuestionType,
  ResearchRequest,
  SearchResultCandidate,
  SourceTier,
  SynthesizedFact,
} from "./domain/research-types.ts";
import { deterministicProfileHints, mergeTravelProfile } from "./domain/profile-extraction.ts";
import { buildPreferenceProfile, scorePreferenceMatch } from "./domain/preference-intelligence.ts";
import { optimizeRouteBuckets, precheckRouteFeasibility } from "./domain/route-optimizer.ts";
import { estimatedRoadMinutes } from "./domain/sparse-transit.ts";
import { buildResearchDecisionTrace, traceCoverage } from "./domain/decision-trace.ts";
import { summarizeTrafficCoverage } from "./domain/traffic-coverage.ts";
import { buildPlanDiversityProfiles } from "./domain/diversity.ts";
import { reproducibilitySnapshot } from "./domain/reproducibility.ts";
import { calibrateCrowdWithResearch, crowdRiskForVisit, predictCrowdRisk } from "./domain/crowd-risk.ts";
import { estimateTripCost } from "./domain/trip-cost.ts";
import { parseAvailabilityWindows } from "./domain/availability.ts";
import { compileConstraintModel } from "./domain/constraint-model.ts";
import { approximateTokens, enforceOutputTokenBudget, modelTokenBudget } from "./domain/model-budget.ts";
import { PLANNING_WORKFLOW_DAG, workflowExecutionGroups } from "./domain/workflow-dag.ts";
import { clamp, cleanText, list, minutesToTime, normalizeName, timeToMinutes } from "./lib/value-utils.ts";
import {
  applyFinalTimelineSafetyRepair,
  bindTrafficMatrixFacts,
  compactPlannerKnowledge,
  completePlannerVariant,
  enforceRequiredCoverage,
  legalizePlannerTimelines,
  normalizePlannerSkeleton,
  normalizePlannerVariant,
  recoverPlannerVariant,
} from "./planning/planner-normalization.ts";
import {
  amapCandidateRecord,
  fallbackPoiCategory,
  haversine,
  isExcludedCandidatePoi,
  nominatimCandidateRecord,
  selectBestAmapDistrict,
  wikiPageToSpot,
} from "./providers/poi-normalization.ts";
import { callMcp, fetchJson, fetchTextResource } from "./providers/provider-client.ts";
import {
  ADVANCE_SOFT_BUDGET_MS,
  EXTERNAL_CALL_MAX_MS,
  MAX_IN_REQUEST_THROTTLE_WAIT_MS,
  createAdvanceExecutionBudget,
  externalCallTimeoutMs,
  isAdvanceBudgetExhausted,
} from "./workflow/advance-budget.ts";
import {
  advancePlannerResearch,
  currentResearchMicroStep,
} from "./workflow/research/research-runner.ts";
import type { PlannerResearchState } from "./workflow/research/research-state.ts";
import { runtimeStateForClient } from "./workflow/runtime-state.ts";
import {
  acquireTravelJobLease,
  addTravelJobEvent,
  activeJobCount,
  configurePersistence,
  consumeRateLimit,
  createTravelJob,
  findActiveTravelJob,
  findLatestTravelJob,
  expireStaleTravelJobs,
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
  resetTravelJobForRetry,
  renewTravelJobLease,
  requestTravelJobCancellation,
  requestClientHash,
  runtimeMetrics,
  sha256,
  updateTravelJob,
} from "./persistence.ts";

export {
  applyFinalTimelineSafetyRepair,
  compactPlannerKnowledge,
  enforceRequiredCoverage,
  fallbackPoiCategory,
  isExcludedCandidatePoi,
  normalizePlannerVariant,
  recoverPlannerVariant,
  selectBestAmapDistrict,
};

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
  ["香港", 22.3193, 114.1694], ["澳门", 22.1987, 113.5439],
] as const;
const unsplashMemory = new Map<string, { expiresAt: number; value: any }>();
const intelligenceMemory = new Map<string, { expiresAt: number; value: any }>();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

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

function htmlText(value: unknown) {
  return cleanText(String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">"));
}

function safeResearchUrl(value: unknown) {
  try {
    const url = new URL(cleanText(value));
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".local") || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) return null;
    return url.toString();
  } catch { return null; }
}

function bingSearchRows(html: string, request: ResearchRequest, provider: string, tierHint?: SourceTier): SearchResultCandidate[] {
  const rows: SearchResultCandidate[] = [];
  const pattern = /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && rows.length < 8) {
    const url = safeResearchUrl(match[1]);
    if (!url) continue;
    const title = htmlText(match[2]);
    const snippet = htmlText(match[3]);
    if (!title) continue;
    rows.push({
      id: `${provider}:${request.queryId}:${rows.length + 1}`,
      queryId: request.queryId,
      title,
      url,
      snippet,
      provider,
      sourceTier: tierHint || classifySourceTier(url, provider),
      discoveredAt: new Date().toISOString(),
      pageStatus: "search_discovered",
      targetId: request.targetId,
      questionType: request.questionType,
    });
  }
  return rows;
}

async function bingWebSearch(request: ResearchRequest, query = request.query, provider = "Bing Web Search", tierHint?: SourceTier) {
  const params = new URLSearchParams({ q: query, setlang: "zh-cn", cc: "cn", count: "10" });
  const result = await fetchTextResource(`https://www.bing.com/search?${params}`, { headers: { accept: "text/html,application/xhtml+xml" } }, 15000, provider);
  if (!result.ok) throw new Error(`${provider}不可用（${result.response.status}）`);
  return bingSearchRows(result.text, request, provider, tierHint);
}

function researchProviderFor(env: any) {
  const crowdTypes = new Set<ResearchQuestionType>(["crowd_pattern", "queue_pattern", "holiday_crowd", "weekend_crowd", "photography_time", "recent_travel_feedback", "visit_duration", "internal_route", "entrance"]);
  const officialTypes = new Set<ResearchQuestionType>(["opening_hours", "special_opening_hours", "temporary_closure", "reservation", "ticket_policy", "transit_change", "construction", "shuttle", "local_access", "seasonal_event", "festival"]);
  const searchProviders = [
    {
      id: "verified-map-entity",
      capabilities: ["entity", "map", "professional"],
      sourceTiers: ["tier_2_professional" as SourceTier],
      supports: () => true,
      search: async (request: ResearchRequest) => {
        const output = await searchVerifiedTravelContext(request.query, "", env);
        return (output.sources || []).slice(0, 8).map((source: any, index: number): SearchResultCandidate => ({
          id: `context:${request.queryId}:${index + 1}`, queryId: request.queryId, title: cleanText(source.name), url: safeResearchUrl(source.url),
          snippet: cleanText(source.snippet || source.address || source.type), provider: cleanText(source.source, "公开实体服务"),
          sourceTier: classifySourceTier(source.url, source.source), discoveredAt: output.fetchedAt, pageStatus: source.url ? "search_discovered" : "snippet_only",
          targetId: request.targetId, questionType: request.questionType,
        }));
      },
    },
    {
      id: "official-directed-web",
      capabilities: ["official", "web"],
      sourceTiers: ["tier_1_official" as SourceTier, "tier_3_news" as SourceTier],
      supports: (request: ResearchRequest) => officialTypes.has(request.questionType),
      search: (request: ResearchRequest) => bingWebSearch(request, `${request.query} (官方 OR 政府 OR 公告)`, "Bing 官方定向搜索"),
    },
    {
      id: "ugc-directed-web",
      capabilities: ["ugc", "experience"],
      sourceTiers: ["tier_4_ugc" as SourceTier],
      supports: (request: ResearchRequest) => crowdTypes.has(request.questionType),
      search: (request: ResearchRequest) => bingWebSearch(request, `${request.query} (游记 OR 游客 OR 排队 OR 实测)`, "Bing UGC 定向搜索", "tier_4_ugc"),
    },
    {
      id: "general-web",
      capabilities: ["web", "news"],
      sourceTiers: ["tier_3_news" as SourceTier, "tier_2_professional" as SourceTier],
      supports: () => true,
      search: (request: ResearchRequest) => bingWebSearch(request),
    },
  ];
  const pageProviders = [{
    id: "public-http-page",
    supports: (url: string) => Boolean(safeResearchUrl(url)),
    fetch: async (url: string) => {
      const fetchedAt = new Date().toISOString();
      try {
        const result = await fetchTextResource(url, { headers: { accept: "text/html,application/xhtml+xml,text/plain,application/json" } }, 15000, "Research Page Reader");
        const contentType = result.response.headers.get("content-type") || "";
        const status = detectPageAccessStatus(result.response.status, result.text.slice(0, 8000), contentType);
        const title = htmlText(result.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
        const publisher = htmlText(result.text.match(/<meta[^>]+(?:name|property)=["'](?:author|og:site_name)["'][^>]+content=["']([^"']+)/i)?.[1]);
        const publishedAt = cleanText(result.text.match(/<meta[^>]+(?:name|property)=["'](?:article:published_time|date|pubdate)["'][^>]+content=["']([^"']+)/i)?.[1]) || undefined;
        return { url, status, title, publisher, publishedAt, text: status === "page_fetched" ? sanitizeUntrustedPage(result.text) : "", fetchedAt, error: result.ok ? undefined : `HTTP ${result.response.status}` };
      } catch (error: any) {
        return { url, status: "network_failed" as PageAccessStatus, fetchedAt, error: cleanText(error?.message) };
      }
    },
  }];
  return new SearchOrchestrator(searchProviders, pageProviders);
}

function evidencePassage(text: string, targetName: string, type: ResearchQuestionType) {
  const keywords: Partial<Record<ResearchQuestionType, RegExp>> = {
    opening_hours: /开放|开园|入园|停止入园|闭园|营业时间/,
    special_opening_hours: /特殊开放|节假日|调整|开放时间/,
    temporary_closure: /暂停开放|临时关闭|闭园|施工|恢复开放/,
    reservation: /预约|实名|限流|购票/,
    ticket_policy: /门票|票价|免票|优惠/,
    crowd_pattern: /人流|拥挤|游客|客流|排队/,
    queue_pattern: /排队|等候|入口/,
    weekend_crowd: /周末|周六|周日|人多|排队/,
    visit_duration: /小时|分钟|游览|耗时/,
    photography_time: /拍照|摄影|光线|日出|日落/,
  };
  const pieces = cleanText(text).split(/[。！？\n]/).filter(Boolean);
  const regex = keywords[type] || new RegExp(targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matched = pieces.filter((piece) => piece.includes(targetName) || regex.test(piece)).slice(0, 3).join("。 ");
  return cleanText(matched || pieces.slice(0, 2).join("。 ")).slice(0, 900);
}

function deterministicExtractedValue(type: ResearchQuestionType, passage: string) {
  if (type === "opening_hours" || type === "special_opening_hours") {
    const times = [...passage.matchAll(/(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/g)].map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
    if (times.length >= 2) return { open: times[0], close: times[1] };
  }
  if (type === "temporary_closure") return /暂停开放|临时关闭|闭园|停止开放/.test(passage) ? { alert: true, note: passage.slice(0, 220) } : null;
  if (type === "reservation") return /无需预约|免预约/.test(passage) ? { required: false } : /预约|实名购票|提前购票/.test(passage) ? { required: true, note: passage.slice(0, 220) } : null;
  if (type === "ticket_policy") {
    if (/免费开放|免费参观|免门票|门票免费|无需门票/.test(passage) && !/部分|不含/.test(passage)) return { free: true, adultPrice: 0, note: passage.slice(0, 260) };
    const price = (regex: RegExp) => Number(passage.match(regex)?.[1] || NaN);
    const adultPrice = price(/(?:成人(?:票|价)?|全价票)[^\d]{0,12}(\d+(?:\.\d+)?)\s*元?/) || price(/(?:门票|票价|价格)[^\d]{0,12}(\d+(?:\.\d+)?)\s*元/);
    const childPrice = price(/(?:儿童|学生)(?:票|价)?[^\d]{0,12}(\d+(?:\.\d+)?)\s*元?/);
    const seniorPrice = price(/(?:老人|老年|长者)(?:票|价)?[^\d]{0,12}(\d+(?:\.\d+)?)\s*元?/);
    if ([adultPrice, childPrice, seniorPrice].some(Number.isFinite)) return { free: false, adultPrice: Number.isFinite(adultPrice) ? adultPrice : null, childPrice: Number.isFinite(childPrice) ? childPrice : null, seniorPrice: Number.isFinite(seniorPrice) ? seniorPrice : null, note: passage.slice(0, 260) };
    return null;
  }
  if (type === "visit_duration") {
    const hours = passage.match(/(\d(?:\.\d)?)\s*(?:个)?小时/);
    const minutes = passage.match(/(\d{2,3})\s*分钟/);
    if (hours) return { typicalMinutes: Math.round(Number(hours[1]) * 60) };
    if (minutes) return { typicalMinutes: Number(minutes[1]) };
  }
  if (["crowd_pattern", "queue_pattern", "weekend_crowd", "holiday_crowd", "recent_travel_feedback"].includes(type)) return passage ? { signal: passage.slice(0, 360), nature: "supporting_signal_not_realtime" } : null;
  return passage ? { note: passage.slice(0, 360) } : null;
}

async function researchEvidenceFromSources(request: ResearchRequest, results: SearchResultCandidate[], pages: Map<string, any>) {
  const evidence: ResearchEvidence[] = [];
  for (const [index, result] of results.entries()) {
    const page = result.url ? pages.get(result.url) : null;
    const pageStatus: PageAccessStatus = page?.status || result.pageStatus || "snippet_only";
    const text = cleanText(page?.text || result.snippet);
    const passage = evidencePassage(text, request.targetName, request.questionType);
    const extractedValue = deterministicExtractedValue(request.questionType, passage);
    const sourceTier = result.sourceTier || classifySourceTier(result.url, result.provider);
    const domain = result.url ? (() => { try { return new URL(result.url).hostname.replace(/^www\./, ""); } catch { return result.provider; } })() : result.provider;
    const contentHash = await sha256(`${passage}|${JSON.stringify(extractedValue)}`);
    const authority = sourceTier === "tier_1_official" ? 0.95 : sourceTier === "tier_2_professional" ? 0.78 : sourceTier === "tier_3_news" ? 0.7 : sourceTier === "tier_4_ugc" ? 0.52 : 0.4;
    const entityMatchConfidence = text.includes(request.targetName) || result.title.includes(request.targetName) ? 0.95 : normalizeName(text).includes(normalizeName(request.targetName)) ? 0.78 : 0.4;
    const row = scoreResearchEvidence({
      id: `evidence:${request.queryId}:${index + 1}`, queryId: request.queryId, targetId: request.targetId, targetName: request.targetName,
      questionType: request.questionType, extractedValue, passage, title: page?.title || result.title, url: result.url,
      publisher: page?.publisher || domain, sourceTier, origin: sourceTier === "tier_1_official" ? "official_web" : sourceTier === "tier_2_professional" ? "professional_web" : sourceTier === "tier_3_news" ? "news" : sourceTier === "tier_4_ugc" ? "ugc" : "unknown",
      pageStatus, publishedAt: page?.publishedAt || result.publishedAt, fetchedAt: page?.fetchedAt || result.discoveredAt,
      authority, relevance: passage ? 0.82 : 0.3, sourceFit: sourceFitFor(request.questionType, sourceTier),
      freshness: sourceFreshness(request.questionType, page?.publishedAt || result.publishedAt), specificity: extractedValue ? 0.82 : passage ? 0.5 : 0.2,
      entityMatchConfidence, commercialBias: /携程|同程|飞猪|优惠|立即预订|套餐/.test(text) ? 0.45 : 0.05,
      seoRisk: /攻略大全|必看攻略|收藏这篇|最全攻略/.test(result.title) && !page?.publishedAt ? 0.55 : 0.05,
      independenceGroupId: `${domain}|${contentHash.slice(0, 16)}`, contentHash, disposition: "weak", rejectionReasons: [],
    });
    evidence.push(row);
  }
  return evidence;
}

function aiExtractionGrounded(row: ResearchEvidence, value: any) {
  if (value == null) return true;
  if (["opening_hours", "special_opening_hours"].includes(row.questionType)) {
    const values = [value?.open, value?.close].filter(Boolean).map((item) => cleanText(item).replace("：", ":"));
    return values.length >= 2 && values.every((item) => cleanText(row.passage).replaceAll("：", ":").includes(item));
  }
  if (row.questionType === "visit_duration" && value?.typicalMinutes) {
    const minutes = Number(value.typicalMinutes);
    return cleanText(row.passage).includes(String(minutes)) || cleanText(row.passage).includes(String(minutes / 60));
  }
  return Boolean(cleanText(row.passage));
}

async function refineEvidenceWithAi(env: any, rows: ResearchEvidence[]) {
  const candidates = rows.filter((row) => row.passage && row.disposition !== "reject").sort((left, right) => Number((scoreResearchEvidence(right) as any).score || 0) - Number((scoreResearchEvidence(left) as any).score || 0)).slice(0, 24);
  if (!candidates.length) return { rows, called: false, model: null };
  const refined = await aiJson(env, {
    purpose: "enrich", thinking: false, maxTokens: 3200, requestTimeoutMs: 90000,
    messages: [
      { role: "system", content: "你是证据抽取器，不是旅游回答器。只能从每条 passage 明示内容中抽取值，不得使用常识补充，不得把搜索摘要当官方验证。输出 JSON：{items:[{evidenceId,extractedValue,relevance,specificity,entityMatchConfidence,disposition,rejectionReasons}]}。若实体不匹配、内容无关或疑似广告/SEO，disposition=reject。数值范围0到1。" },
      { role: "user", content: JSON.stringify(candidates.map((row) => ({ evidenceId: row.id, targetName: row.targetName, questionType: row.questionType, sourceTier: row.sourceTier, pageStatus: row.pageStatus, title: row.title, passage: row.passage }))) },
    ],
  });
  const items = new Map(list(refined.value?.items).map((item: any) => [cleanText(item.evidenceId), item]));
  return {
    called: true,
    model: refined.model,
    rows: rows.map((row) => {
      const item: any = items.get(row.id);
      if (!item) return row;
      const extractedValue = aiExtractionGrounded(row, item.extractedValue) ? item.extractedValue : row.extractedValue;
      const rescored = scoreResearchEvidence({
        ...row,
        extractedValue,
        relevance: Math.max(0, Math.min(1, Number(item.relevance ?? row.relevance))),
        specificity: Math.max(0, Math.min(1, Number(item.specificity ?? row.specificity))),
        entityMatchConfidence: Math.max(0, Math.min(1, Number(item.entityMatchConfidence ?? row.entityMatchConfidence))),
        disposition: cleanText(item.disposition) === "reject" ? "reject" : row.disposition,
        rejectionReasons: cleanText(item.disposition) === "reject" ? list(item.rejectionReasons).map(cleanText).filter(Boolean).slice(0, 5) : row.rejectionReasons,
      });
      return { ...rescored, extractionModel: refined.model };
    }),
  };
}

function factsByTarget(facts: SynthesizedFact[]) {
  const byTarget = new Map<string, SynthesizedFact[]>();
  for (const fact of facts) {
    const rows = byTarget.get(fact.targetId) || [];
    rows.push(fact);
    byTarget.set(fact.targetId, rows);
  }
  return byTarget;
}

async function runResearchAgent(profile: any, knowledge: any, env: any) {
  const startedAt = Date.now();
  let gaps = buildResearchGapMap(profile, knowledge.spots || [], profile.deepReasoning === false ? 10 : 15);
  let budget = createAdaptiveResearchBudget({
    tripDays: Number(profile.days || 1), cityCount: 1, requiredSpotCount: list(profile.requiredAttractions).length,
    blockingUnknownCount: gaps.filter((gap) => gap.blocking).length, highRiskFactCount: gaps.filter((gap) => gap.decisionImpact >= 0.8).length,
    candidateCount: knowledge.spots?.length || 0, dynamicEventCount: list(profile.seasonalNeeds).length, deepResearch: profile.deepReasoning !== false,
  });
  const orchestrator = researchProviderFor(env);
  const allRequests: ResearchRequest[] = [];
  const searchExecutions: any[] = [];
  const pages = new Map<string, any>();
  const allEvidence: ResearchEvidence[] = [];
  let facts: SynthesizedFact[] = [];
  let aiCallCount = 0;
  let modelStatus = "unavailable";
  let model = aiPrimaryModel(env, "research");
  let recentInformationGains: number[] = [];
  let stopReason = "budget_exhausted";
  const maxRounds = profile.deepReasoning === false ? 2 : 3;
  const usedQueryKeys = new Set<string>();

  for (let round = 1; round <= maxRounds; round += 1) {
    const continuation = shouldContinueResearch({ gaps, budget, recentInformationGains, queriesExecuted: allRequests.length });
    if (!continuation.continue) { stopReason = continuation.reason; break; }
    let requests: ResearchRequest[] = [];
    // The first model pass sets the research direction. Later rounds can use
    // the remaining ranked gaps directly instead of repeatedly asking Pro to
    // plan nearly identical queries before each evidence fetch.
    if (round === 1 && budget.aiCallBudget > aiCallCount) {
      try {
        const planned = await aiJson(env, {
          purpose: "research", thinking: false, maxTokens: 2600, requestTimeoutMs: 90000,
          messages: [
            { role: "system", content: "你是旅游Research Planner。只决定缺少哪些会改变路线的事实以及应搜索什么，不回答事实本身。只输出JSON：{requests:[{targetId,questionType,query,reason,expectedDecisionImpact,expectedInformationGain,estimatedCost}]}。只能使用给定gap中的targetId和questionType；query必须包含目标景点并结合日期/星期/官方名称或合适来源角度。优先可执行性、开放、预约、临时限制、人流、交通和最佳时段；用户设置预算且存在 ticket_policy 缺口时，至少包含一条门票或免费政策查询；不要搜索低决策影响的文化背景。" },
            { role: "user", content: JSON.stringify({ city: profile.city, startDate: profile.startDate, days: profile.days, preferences: profile.preferences, requiredAttractions: profile.requiredAttractions, round, remainingBudget: budget, gaps: gaps.slice(0, 35).map((gap) => ({ ...gap, utility: researchUtility(gap) })), existingFacts: facts }) },
          ],
        });
        aiCallCount += 1;
        model = planned.model;
        modelStatus = "ready";
        requests = normalizeAiResearchRequests(planned.value, profile, gaps, budget);
      } catch (error) {
        if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
        modelStatus = modelStatus === "ready" ? "degraded" : "unavailable";
      }
    }
    if (!requests.length) requests = deterministicResearchRequests(profile, gaps, budget);
    requests = requests.filter((request) => {
      const key = `${request.targetId}|${request.questionType}|${request.query.toLowerCase().replace(/\s+/g, "")}`;
      if (usedQueryKeys.has(key)) return false;
      usedQueryKeys.add(key);
      return true;
    }).slice(0, Math.max(0, Math.min(budget.targetQueryBudget - allRequests.length, round === 1 ? 8 : 5)));
    if (!requests.length) { stopReason = "stalled"; break; }
    allRequests.push(...requests.map((request) => ({ ...request, executedAt: new Date().toISOString() })));
    const executions = await mapWithConcurrency(requests, 3, async (request) => {
      const cacheKey = `${request.targetId}|${request.questionType}|${request.query}`;
      const cached = await persistentCacheGet(`research-search:${FACT_POLICY_VERSION}`, cacheKey) as any;
      if (cached?.results) return cached;
      const execution = await orchestrator.execute(request, 2);
      const searchPolicy = FACT_FRESHNESS_POLICIES[request.questionType] || FACT_FRESHNESS_POLICIES.recent_travel_feedback;
      await persistentCachePut(`research-search:${FACT_POLICY_VERSION}`, cacheKey, execution, searchPolicy.searchCacheTtlMs);
      return execution;
    });
    for (const settled of executions) if (settled.status === "fulfilled") searchExecutions.push(settled.value);
    const roundResults = searchExecutions.filter((execution) => requests.some((request) => request.queryId === execution.request.queryId)).flatMap((execution) => execution.results || []);
    const pageUrls = [...new Set(roundResults.map((result: any) => result.url).filter(Boolean))].slice(0, Math.max(0, budget.targetPageBudget - pages.size));
    const fetched = await mapWithConcurrency(pageUrls, 3, async (url: string) => {
      const cached = await persistentCacheGet(`research-page:${FACT_POLICY_VERSION}`, url) as any;
      if (cached?.status) return cached;
      const page = await orchestrator.fetchPage(url);
      const related = roundResults.find((result: any) => result.url === url);
      const pagePolicy = related ? FACT_FRESHNESS_POLICIES[related.questionType] : null;
      const ttl = pagePolicy?.pageCacheTtlMs || 6 * 60 * 60 * 1000;
      await persistentCachePut(`research-page:${FACT_POLICY_VERSION}`, url, page, ttl);
      return page;
    });
    fetched.forEach((outcome, index) => { if (outcome.status === "fulfilled") pages.set(pageUrls[index], outcome.value); });
    const roundEvidence: ResearchEvidence[] = [];
    for (const request of requests) {
      const results = roundResults.filter((result: any) => result.queryId === request.queryId);
      roundEvidence.push(...await researchEvidenceFromSources(request, results, pages));
    }
    if (budget.aiCallBudget > aiCallCount && roundEvidence.length) {
      try {
        const refined = await refineEvidenceWithAi(env, roundEvidence);
        if (refined.called) {
          aiCallCount += 1;
          modelStatus = "ready";
          allEvidence.push(...refined.rows);
        } else allEvidence.push(...roundEvidence);
      } catch (error) {
        if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
        modelStatus = modelStatus === "ready" ? "degraded" : modelStatus;
        allEvidence.push(...roundEvidence);
      }
    } else {
      allEvidence.push(...roundEvidence);
    }
    const beforeResolved = gaps.filter((gap) => gap.currentStatus !== "unknown" && gap.currentStatus !== "conflicting").reduce((sum, gap) => sum + gap.decisionImpact, 0);
    const grouped = new Map<string, ResearchEvidence[]>();
    for (const row of allEvidence) {
      const key = `${row.targetId}:${row.questionType}`;
      const values = grouped.get(key) || [];
      values.push(row);
      grouped.set(key, values);
    }
    facts = [...grouped.values()].map((rows) => {
      const targetId = cleanText(rows[0]?.targetId);
      const factType = rows[0]?.questionType as ResearchQuestionType;
      return synthesizeFact(targetId, rows[0]?.targetName || targetId, factType, rows);
    });
    gaps = applyFactsToGaps(gaps, facts);
    const afterResolved = gaps.filter((gap) => gap.currentStatus !== "unknown" && gap.currentStatus !== "conflicting").reduce((sum, gap) => sum + gap.decisionImpact, 0);
    const realizedGain = Number(Math.max(0, (afterResolved - beforeResolved) / Math.max(1, gaps.reduce((sum, gap) => sum + gap.decisionImpact, 0))).toFixed(3));
    recentInformationGains.push(realizedGain);
    budget = spendResearchBudget(budget, requests.reduce((sum, request) => sum + request.estimatedCost, 0) + pageUrls.length * 0.5 + 1.5);
    budget = extendResearchBudget(budget, gaps.filter((gap) => gap.blocking && (gap.currentStatus === "unknown" || gap.currentStatus === "conflicting")).length, realizedGain);
    stopReason = round === maxRounds ? "round_limit" : "continuing";
  }

  const acceptedEvidence = allEvidence.filter((row) => row.disposition !== "reject");
  const deduped = deduplicateEvidence(acceptedEvidence);
  const metrics = researchMetrics({ rawResultCount: searchExecutions.reduce((sum, execution) => sum + (execution.results?.length || 0), 0), pageReadCount: pages.size, evidence: allEvidence, facts, gaps, searchCount: allRequests.length, aiCallCount, realizedInformationGain: recentInformationGains.reduce((sum, gain) => sum + gain, 0) });
  const report = {
    version: "research-intelligence-v1", status: searchExecutions.length ? (facts.some((fact) => fact.status === "verified" || fact.status === "supported") ? "ready" : "degraded") : "unavailable",
    model, modelStatus, budget: { ...budget, stopReason }, rounds: recentInformationGains.length, requests: allRequests,
    skipped: skippedResearchItems(gaps, allRequests, budget.remainingCostUnits <= 0 || allRequests.length >= budget.targetQueryBudget), searchExecutions,
    pageSummary: [...pages.values()].map((page) => ({ url: page.url, status: page.status, title: page.title, publisher: page.publisher, publishedAt: page.publishedAt, fetchedAt: page.fetchedAt, error: page.error })),
    evidence: deduped.independent, rejectedEvidence: allEvidence.filter((row) => row.disposition === "reject").map((row) => ({ id: row.id, url: row.url, reasons: row.rejectionReasons })),
    facts, gaps, metrics, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    dataPolicy: "网页均作为不可信外部证据处理；snippet不能验证关键事实；冲突保持conflicting；无官方实时客流时只生成预测信号。",
  };
  for (const fact of facts) {
    const policy = FACT_FRESHNESS_POLICIES[fact.factType] || FACT_FRESHNESS_POLICIES.recent_travel_feedback;
    await persistentCachePut(`research-fact:${FACT_POLICY_VERSION}`, `${profile.city}|${profile.startDate}|${fact.targetId}|${fact.factType}`, fact, policy.factCacheTtlMs);
  }
  return report;
}

async function advanceResearchAgentCheckpoint(jobId: string, profile: any, knowledge: any, env: any) {
  const orchestrator = researchProviderFor(env);
  const store = {
    get: (key: string) => getTravelJobArtifact(jobId, key),
    put: (key: string, value: unknown) => putTravelJobArtifact(jobId, key, value),
  };
  const result = await advancePlannerResearch(store, {
    initialize: async () => {
      const gaps = buildResearchGapMap(profile, knowledge.spots || [], profile.deepReasoning === false ? 10 : 15);
      const budget = createAdaptiveResearchBudget({
        tripDays: Number(profile.days || 1), cityCount: 1, requiredSpotCount: list(profile.requiredAttractions).length,
        blockingUnknownCount: gaps.filter((gap) => gap.blocking).length,
        highRiskFactCount: gaps.filter((gap) => gap.decisionImpact >= 0.8).length,
        candidateCount: knowledge.spots?.length || 0, dynamicEventCount: list(profile.seasonalNeeds).length,
        deepResearch: profile.deepReasoning !== false,
      });
      return { gaps, budget, maxRounds: profile.deepReasoning === false ? 2 : 3 };
    },
    planQueries: async (state) => {
      const continuation = shouldContinueResearch({ gaps: state.gaps, budget: state.budget, recentInformationGains: state.informationGains, queriesExecuted: state.completedQueryIds.length });
      if (!continuation.continue) {
        state.stopReason = continuation.reason;
        return { requests: [], model: state.model, modelStatus: state.modelStatus };
      }
      const previousRequests = (await Promise.all(state.queryArtifactKeys.map((key) => getTravelJobArtifact(jobId, key)))).flatMap((value: any) => list(value));
      const usedKeys = new Set(previousRequests.map((request: any) => `${request.targetId}|${request.questionType}|${cleanText(request.query).toLowerCase().replace(/\s+/g, "")}`));
      let requests: ResearchRequest[] = [];
      let model = state.model;
      let modelStatus = state.modelStatus;
      let degradedReason = "";
      let aiCalls = 0;
      if (state.round === 0 && state.budget.aiCallBudget > state.aiCallCount) {
        try {
          const planned = await aiJson(env, {
            purpose: "research", thinking: false, maxTokens: 2600, requestTimeoutMs: EXTERNAL_CALL_MAX_MS,
            messages: [
              { role: "system", content: "你是旅游Research Planner。只决定缺少哪些会改变路线的事实以及应搜索什么，不回答事实本身。只输出JSON：{requests:[{targetId,questionType,query,reason,expectedDecisionImpact,expectedInformationGain,estimatedCost}]}。只能使用给定gap中的targetId和questionType；query必须包含目标景点并结合日期/星期/官方名称或合适来源角度。优先可执行性、开放、预约、临时限制、人流、交通和最佳时段；用户设置预算且存在 ticket_policy 缺口时，至少包含一条门票或免费政策查询；不要搜索低决策影响的文化背景。" },
              { role: "user", content: JSON.stringify({ city: profile.city, startDate: profile.startDate, days: profile.days, preferences: profile.preferences, requiredAttractions: profile.requiredAttractions, round: state.round + 1, remainingBudget: state.budget, gaps: state.gaps.slice(0, 35).map((gap) => ({ ...gap, utility: researchUtility(gap) })) }) },
            ],
          });
          requests = normalizeAiResearchRequests(planned.value, profile, state.gaps, state.budget);
          model = planned.model;
          modelStatus = "ready";
          aiCalls = 1;
        } catch (error: any) {
          if (isDurableAiWait(error) || isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
          degradedReason = `AI research query planner timeout/unavailable：${cleanText(error?.message)}`;
          modelStatus = state.modelStatus === "ready" ? "degraded" : "unavailable";
        }
      }
      if (!requests.length) requests = deterministicResearchRequests(profile, state.gaps, state.budget);
      requests = requests.filter((request) => {
        const key = `${request.targetId}|${request.questionType}|${request.query.toLowerCase().replace(/\s+/g, "")}`;
        if (usedKeys.has(key)) return false;
        usedKeys.add(key);
        return true;
      }).slice(0, Math.max(0, Math.min(state.budget.targetQueryBudget - state.completedQueryIds.length, state.round === 0 ? 8 : 5)));
      return { requests, model, modelStatus, degradedReason: degradedReason || undefined, aiCalls };
    },
    search: async (requests, operationId) => {
      const executions = await mapWithConcurrency(requests, 2, async (request) => {
        const cacheKey = `${request.targetId}|${request.questionType}|${request.query}`;
        const cached = await persistentCacheGet(`research-search:${FACT_POLICY_VERSION}`, cacheKey) as any;
        if (cached?.results) return cached;
        const execution = await orchestrator.execute(request, 2);
        const policy = FACT_FRESHNESS_POLICIES[request.questionType] || FACT_FRESHNESS_POLICIES.recent_travel_feedback;
        await persistentCachePut(`research-search:${FACT_POLICY_VERSION}`, cacheKey, execution, policy.searchCacheTtlMs);
        return execution;
      });
      return executions.filter((item) => item.status === "fulfilled").map((item: any) => item.value);
    },
    fetch: async (urls) => {
      const fetched = await mapWithConcurrency(urls, 3, async (url: string) => {
        const cached = await persistentCacheGet(`research-page:${FACT_POLICY_VERSION}`, url) as any;
        if (cached?.status) return cached;
        const page = await orchestrator.fetchPage(url);
        await persistentCachePut(`research-page:${FACT_POLICY_VERSION}`, url, page, 6 * 60 * 60 * 1000);
        return page;
      });
      return fetched.map((item: any, index) => item.status === "fulfilled" ? item.value : ({ url: urls[index], status: "network_failed", fetchedAt: new Date().toISOString(), error: cleanText(item.reason?.message) }));
    },
    extract: async ({ requests, executions, pages }) => {
      const pageMap = new Map(pages.map((page: any) => [page.url, page]));
      const evidence: ResearchEvidence[] = [];
      for (const request of requests) {
        const results = executions.filter((execution) => execution.request.queryId === request.queryId).flatMap((execution) => execution.results || []);
        evidence.push(...await researchEvidenceFromSources(request, results, pageMap));
      }
      return evidence;
    },
    refine: async (evidence) => {
      if (!evidence.length) return { evidence, aiCalls: 0 };
      try {
        const refined = await refineEvidenceWithAi(env, evidence);
        return { evidence: refined.rows, model: refined.model, aiCalls: refined.called ? 1 : 0 };
      } catch (error: any) {
        if (isDurableAiWait(error) || isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
        return { evidence, aiCalls: 0, degradedReason: `AI evidence extraction timeout/unavailable：${cleanText(error?.message)}` };
      }
    },
    fuse: async ({ state, requests, executions, pages, evidence }) => {
      const beforeResolved = state.gaps.filter((gap) => gap.currentStatus !== "unknown" && gap.currentStatus !== "conflicting").reduce((sum, gap) => sum + gap.decisionImpact, 0);
      const grouped = new Map<string, ResearchEvidence[]>();
      for (const row of evidence) {
        const key = `${row.targetId}:${row.questionType}`;
        const values = grouped.get(key) || [];
        values.push(row);
        grouped.set(key, values);
      }
      const facts = [...grouped.values()].map((rows) => synthesizeFact(rows[0].targetId, rows[0].targetName, rows[0].questionType, rows));
      const gaps = applyFactsToGaps(state.gaps, facts);
      const afterResolved = gaps.filter((gap) => gap.currentStatus !== "unknown" && gap.currentStatus !== "conflicting").reduce((sum, gap) => sum + gap.decisionImpact, 0);
      const informationGain = Number(Math.max(0, (afterResolved - beforeResolved) / Math.max(1, gaps.reduce((sum, gap) => sum + gap.decisionImpact, 0))).toFixed(3));
      const currentIds = new Set(state.pendingQueryIds);
      const roundRequests = requests.filter((request) => currentIds.has(request.queryId));
      const roundPageCount = new Set(executions.filter((execution) => currentIds.has(execution.request.queryId)).flatMap((execution) => execution.results.map((row) => row.url).filter(Boolean))).size;
      let budget = spendResearchBudget(state.budget, roundRequests.reduce((sum, request) => sum + request.estimatedCost, 0) + roundPageCount * 0.5 + 1.5);
      budget = extendResearchBudget(budget, gaps.filter((gap) => gap.blocking && (gap.currentStatus === "unknown" || gap.currentStatus === "conflicting")).length, informationGain);
      const continuation = shouldContinueResearch({ gaps, budget, recentInformationGains: [...state.informationGains, informationGain], queriesExecuted: state.completedQueryIds.length });
      return { facts, gaps, budget, informationGain, continueResearch: continuation.continue, stopReason: continuation.reason || "continuing" };
    },
    finalize: async ({ state, requests, executions, pages, evidence, facts }) => {
      const accepted = evidence.filter((row) => row.disposition !== "reject");
      const deduped = deduplicateEvidence(accepted);
      const metrics = researchMetrics({
        rawResultCount: executions.reduce((sum, execution) => sum + (execution.results?.length || 0), 0), pageReadCount: pages.length,
        evidence, facts, gaps: state.gaps, searchCount: requests.length, aiCallCount: state.aiCallCount,
        realizedInformationGain: state.informationGains.reduce((sum, gain) => sum + gain, 0),
      });
      await Promise.all(facts.map((fact) => {
        const policy = FACT_FRESHNESS_POLICIES[fact.factType] || FACT_FRESHNESS_POLICIES.recent_travel_feedback;
        return persistentCachePut(`research-fact:${FACT_POLICY_VERSION}`, `${profile.city}|${profile.startDate}|${fact.targetId}|${fact.factType}`, fact, policy.factCacheTtlMs);
      }));
      return {
        version: "research-intelligence-v30", status: executions.length ? (facts.some((fact) => fact.status === "verified" || fact.status === "supported") ? "ready" : "degraded") : "unavailable",
        model: state.model || aiPrimaryModel(env, "research"), modelStatus: state.modelStatus, modelError: state.degradedReasons.join("；"),
        budget: { ...state.budget, stopReason: state.stopReason }, rounds: state.informationGains.length, requests,
        skipped: skippedResearchItems(state.gaps, requests, state.budget.remainingCostUnits <= 0 || requests.length >= state.budget.targetQueryBudget),
        searchExecutions: executions,
        pageSummary: pages.map((page) => ({ url: page.url, status: page.status, title: page.title, publisher: page.publisher, publishedAt: page.publishedAt, fetchedAt: page.fetchedAt, error: page.error })),
        evidence: deduped.independent, rejectedEvidence: evidence.filter((row) => row.disposition === "reject").map((row) => ({ id: row.id, url: row.url, reasons: row.rejectionReasons })),
        facts, gaps: state.gaps, metrics, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(state.startedAt),
        durableState: { version: state.version, completedQueryIds: state.completedQueryIds, searchOperationIds: state.searchOperationIds, fetchOperationIds: state.fetchOperationIds, extractOperationIds: state.extractOperationIds, refineOperationIds: state.refineOperationIds },
        dataPolicy: "网页均作为不可信外部证据处理；snippet不能验证关键事实；冲突保持conflicting；无官方实时客流时只生成预测信号。",
      };
    },
  });
  return result;
}

function applyResearchFactsToKnowledge(knowledge: any, research: any) {
  if (!research?.facts?.length) return knowledge;
  const facts = factsByTarget(research.facts);
  return {
    ...knowledge,
    research,
    spots: (knowledge.spots || []).map((spot: any) => {
      const spotFacts = facts.get(spot.id) || [];
      const opening = spotFacts.find((fact) => fact.factType === "special_opening_hours" && fact.status !== "unknown") || spotFacts.find((fact) => fact.factType === "opening_hours" && fact.status !== "unknown");
      const reservation = spotFacts.find((fact) => fact.factType === "reservation" && fact.status !== "unknown");
      const ticket = spotFacts.find((fact) => fact.factType === "ticket_policy" && fact.status !== "unknown");
      const ticketValue = ticket?.value && typeof ticket.value === "object" ? (ticket.value.adult ?? ticket.value.price ?? ticket.value.amount) : ticket?.value;
      const ticketPrice = Number(String(ticketValue ?? "").replace(/[^\d.]/g, ""));
      const crowdSignals = spotFacts.filter((fact) => ["crowd_pattern", "queue_pattern", "weekend_crowd", "holiday_crowd"].includes(fact.factType) && fact.status !== "unknown");
      return {
        ...spot,
        openingHours: opening?.value?.open && opening?.value?.close ? `${opening.value.open}-${opening.value.close}` : spot.openingHours,
        openingStatus: opening ? opening.status : spot.openingStatus,
        reservation: reservation ? { ...spot.reservation, status: reservation.status, researchValue: reservation.value, evidenceIds: reservation.supportingEvidenceIds } : spot.reservation,
        ticketPrice: Number.isFinite(ticketPrice) && ticketPrice >= 0 ? ticketPrice : spot.ticketPrice,
        researchFacts: spotFacts,
        crowdResearchSignals: crowdSignals,
      };
    }),
    unknowns: [...new Set([...(knowledge.unknowns || []), ...research.facts.filter((fact: any) => fact.status === "unknown" || fact.status === "conflicting").map((fact: any) => `${fact.targetName}：${fact.factType} ${fact.status}`)])],
  };
}

function applyResearchToPrepared(prepared: any, research: any) {
  if (!research?.facts?.length) return prepared;
  const knowledge = applyResearchFactsToKnowledge(prepared.knowledge, research);
  const researchedById = new Map(list(knowledge.spots).map((spot: any) => [spot.id, spot]));
  const evidenceById = new Map(list(research.evidence).map((row: any) => [row.id, row]));
  const visitDate = cleanText(prepared.knowledge?.profile?.startDate || prepared.profile?.startDate || research?.gaps?.[0]?.targetDate).slice(0, 10);
  const mergeSpot = (spot: any) => {
    const researched: any = researchedById.get(spot.id) || {};
    const crowdFacts = list(researched.researchFacts).filter((fact: any) => ["crowd_pattern", "queue_pattern", "weekend_crowd", "holiday_crowd"].includes(fact.factType) && fact.status !== "unknown");
    const signals = crowdFacts.flatMap((fact: any) => list(fact.supportingEvidenceIds).map((evidenceId: string) => {
      const evidence: any = evidenceById.get(evidenceId);
      const text = cleanText(evidence?.passage || evidence?.title);
      return {
        evidenceId,
        sampleDate: cleanText(evidence?.publishedAt).slice(0, 10) || null,
        sourceTier: evidence?.sourceTier,
        queueSeverity: /排队.{0,8}(2|3|4|两|三|四)小时|爆满|限流|拥堵严重|人山人海/.test(text) ? "high" : /排队|拥挤|人多|客流高/.test(text) ? "medium" : /人少|无需排队|客流低/.test(text) ? "low" : "unknown",
      };
    }));
    const crowd = calibrateCrowdWithResearch(researched.crowdRisk || researched.crowd || spot.crowdRisk || spot.crowd, visitDate, signals);
    return { ...spot, ...researched, crowd, crowdRisk: crowd };
  };
  return {
    ...prepared,
    knowledge,
    plannerSpots: list(prepared.plannerSpots).map(mergeSpot),
    spots: list(prepared.spots).map(mergeSpot),
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
  if (!key) throw new Error("部署环境尚未配置模型 API Key");
  const candidates = aiModelCandidates(env, options.purpose);
  const failures: string[] = [];
  const endpoint = aiEndpoint(env);
  const provider = aiProviderLabel(endpoint);
  // Share a quota across all roles/models using the same account, across Worker isolates.
  const quotaScope = `${endpoint}|${key}`;
  for (const model of candidates) {
    const circuit = modelCircuitState(endpoint, model);
    if (circuit && circuit.code !== "RATE_LIMITED") {
      failures.push(`${model}: [${circuit.code}] 熔断至 ${new Date(circuit.until).toISOString()}：${circuit.reason}`);
      continue;
    }
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
          max_tokens: enforceOutputTokenBudget(options.purpose, options.maxTokens),
          stream: false,
          thinking: { type: options.thinking ? "enabled" : "disabled" },
          chat_template_kwargs: { enable_thinking: Boolean(options.thinking) },
        };
        if (options.jsonMode && !options.thinking) payload.response_format = { type: "json_object" };
        if (!options.thinking) payload.temperature = options.jsonMode ? 0.1 : 0.25;
        // One auditable search round is enough: the model may request up to three
        // queries in that round, then it must synthesize from the returned evidence.
        if (tools && toolLog.length === 0) { payload.tools = tools; payload.tool_choice = "auto"; }
        const longRunning = options.thinking || options.purpose === "planner" || options.purpose === "repair";
        const requestedTimeoutMs = options.requestTimeoutMs || (longRunning ? 120000 : 60000);
        const requestTimeoutMs = env.ADVANCE_EXECUTION_BUDGET
          ? externalCallTimeoutMs(env.ADVANCE_EXECUTION_BUDGET, requestedTimeoutMs)
          : Math.min(EXTERNAL_CALL_MAX_MS, requestedTimeoutMs);
        const result = await requestWithAiThrottle(async () => {
          const providerCallStartedAt = Date.now();
          await env.AI_RUNTIME_UPDATE?.({ provider, model, providerCallStartedAt, providerOutcome: "running" });
          try {
            const value = await fetchJson(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: JSON.stringify(payload),
            }, requestTimeoutMs, `${provider} ${model}`);
            await env.AI_RECORD_MODEL_ATTEMPT?.({ purpose: options.purpose, provider, model, providerCallStartedAt, providerCallDurationMs: Date.now() - providerCallStartedAt, providerOutcome: "success" });
            return value;
          } catch (error: any) {
            const code = classifyAiFailure(error);
            const providerOutcome = code === "TIMEOUT" ? "timeout" : code === "RATE_LIMITED" ? "rate_limited" : "failed";
            await env.AI_RECORD_MODEL_ATTEMPT?.({ purpose: options.purpose, provider, model, providerCallStartedAt, providerCallDurationMs: Date.now() - providerCallStartedAt, providerOutcome, error: cleanText(error?.message) });
            throw error;
          }
        }, {
          acquire: () => acquireAiRequestSlot(quotaScope, aiRequestInterval(env)),
          block: (milliseconds) => blockAiRequests(quotaScope, milliseconds),
          sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          now: Date.now, random: Math.random, assertActive: env.AI_ASSERT_ACTIVE,
          inRequestWaitBudgetMs: MAX_IN_REQUEST_THROTTLE_WAIT_MS,
        });
        const message = result?.choices?.[0]?.message;
        if (!message) throw new Error(`${provider} ${model} 没有返回消息`);
        const content = cleanText(message.content);
        const reasoningContent = cleanText(message.reasoning_content);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (content && (toolLog.length > 0 || !calls.length || cleanText(result?.choices?.[0]?.finish_reason) !== "tool_calls")) {
          closeModelCircuit(endpoint, model);
          return { content, reasoningContent, model: cleanText(result?.model, model), toolLog, attemptedModels: [...failures, model] };
        }
        if (options.allowReasoningOnly && reasoningContent && !calls.length) {
          closeModelCircuit(endpoint, model);
          return { content: "", reasoningContent, model: cleanText(result?.model, model), toolLog, attemptedModels: [...failures, model] };
        }
        if (!calls.length) throw new Error(`${provider} ${model} 没有返回内容`);
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
      if (/TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
      if (isDurableAiWait(error) || isAdvanceBudgetExhausted(error)) throw error;
      const classified = classifyAiFailure(error);
      openModelCircuit(endpoint, model, error);
      failures.push(`${model}: [${classified}] ${cleanText(error?.message, "请求失败")}`);
      if (classified === "UNAUTHORIZED" || isAiRateLimited(error)) break;
    }
  }
  throw new Error(`${provider} 模型均不可用：${failures.join("；")}`);
}

async function aiJson(env: any, options: Parameters<typeof aiRequest>[1]) {
  const first = await aiRequest(env, { ...options, jsonMode: true });
  try { return { value: parseJsonObject(first.content), model: first.model, toolLog: first.toolLog, formatRepaired: false }; }
  catch {
    const repaired = await aiRequest(env, {
      purpose: options.purpose,
      thinking: false,
      maxTokens: options.maxTokens,
      requestTimeoutMs: options.requestTimeoutMs,
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
  const replanRequired = input?.replanContext?.days?.flatMap((day: any) => (day?.items || []).filter((item: any) => item?.requiredByUser).map((item: any) => cleanText(item?.name))).filter(Boolean) || [];
  if (input?.replanContext && cleanText(input.city) && cleanText(input.startDate) && Number(input.days) > 0 && Number(input.partySize) > 0) {
    const merged = mergeTravelProfile(input, { ...hints, requiredAttractions: [...new Set([...list(hints.requiredAttractions), ...replanRequired])] });
    return { ...merged, extractionModel: "结构化重规划复用（未重复调用模型）", extractionFormatRepaired: false, extractionFallbackReason: "", extractionReuseReason: "复用已确认用户画像，避免自动重规划重复消耗 V4 Flash 配额" };
  }
  const prompt = `请把用户的中国旅行需求整理成严格 json。用户原文是事实提取的第一优先级；当前表单只是原文没提到字段时的默认参数，绝不能用表单默认人数、日期、天数覆盖原文。支持中文数字以及“8.25出发”“8月25日”“明天出发”等口语日期；没有年份时按中国时区、相对今天 ${today} 推断最近的未过日期。只提取用户明确表达或可直接计算的信息，不虚构景点、客流、预约、天气、酒店价格。用户明确说“想去/希望去/必须去”的地点属于 requiredAttractions，普通兴趣偏好不得提升为必去。\n字段：city,startDate(YYYY-MM-DD),days,nights,partySize,adults,children,seniors,budget,budgetLevel,style,preferences(string[]),interestPriorities([{name,priority}]),avoid(string[]),requiredAttractions(string[]),excludedAttractions(string[]),pace,transport,hotelPreference,lodgingArea,dayStart(HH:mm),dayEnd(HH:mm),mealPreference,crowdSensitivity,weatherSensitivity,walkingSensitivity,seasonalNeeds(string[]),requestedVariants(string[]),returnTime,tripPurpose(first_visit|repeat_visit|business|family|photography|food|general),unknownFields(string[]),clarificationNeeded(boolean),clarificationQuestion(string)。未明确字段填 "Unknown" 或放入 unknownFields，不得自行猜测。当前规划器一次只支持一个明确城市或区县；目的地时区由后端实体解析，模型不得猜。\n当前表单（仅作缺省值）：${JSON.stringify({ ...input, freeText: undefined })}\n用户原文（最高优先级）：${cleanText(input.freeText)}`;
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
    if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
    extracted = {
      value: hints,
      model: "deepseek-flash（兼容旧 deepseek-v4-flash；限流时文本规则兜底）",
      formatRepaired: false,
      fallbackReason: cleanText(error?.message, "需求模型暂不可用"),
    };
  }
  const merged = mergeDeterministicProfile(hints, extracted.value);
  return { ...mergeTravelProfile(input, merged), extractionModel: extracted.model, extractionFormatRepaired: extracted.formatRepaired, extractionFallbackReason: extracted.fallbackReason || "" };
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
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset",
    forecast_days: "16",
  });
  const raw = await fetchJson(`${OPEN_METEO}?${params}`, {}, 18000, "Open-Meteo 天气服务");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const forecast16 = (raw?.daily?.time || []).map((date: string, idx: number) => ({
    date, quality: "forecast", weatherCode: raw.daily.weather_code[idx],
    temperatureMax: raw.daily.temperature_2m_max[idx], temperatureMin: raw.daily.temperature_2m_min[idx],
    precipitationProbability: raw.daily.precipitation_probability_max[idx], windSpeed: raw.daily.wind_speed_10m_max?.[idx],
    sunrise: cleanText(raw.daily.sunrise?.[idx]).slice(11, 16) || null,
    sunset: cleanText(raw.daily.sunset?.[idx]).slice(11, 16) || null,
    source: "Open-Meteo",
  }));
  const byDate = new Map(forecast16.map((day: any) => [day.date, day]));
  const tripForecast = Array.from({ length: days }, (_, index) => {
    const date = addDays(startDate, index);
    return byDate.get(date) || { date, quality: "unavailable", note: diffDays(today, date) > 15 ? "出行日期超过当前逐日预报范围；未用今日天气替代" : "该日期暂无逐日预报" };
  });
  return { city: city.name, current: raw.current || {}, tripForecast, forecast16, fetchedAt: new Date().toISOString(), source: "Open-Meteo（未来 16 天）" };
}

async function weatherFor(city: any, startDate: string, days: number) {
  return weatherDirect(city, startDate, days);
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
  const preferenceMatch = scorePreferenceMatch(spot, buildPreferenceProfile(profile), "hot");
  const matched = preferenceMatch.matched;
  const preference = preferenceMatch.score;
  const rating = Number(spot.rating || 0);
  const ratingCount = Math.max(0, Number(spot.ratingCount || spot.reviewCount || spot.commentCount || 0));
  const cityPrior = 4.2;
  const shrunkRating = rating > 0 ? (ratingCount / (ratingCount + 120)) * rating + (120 / (ratingCount + 120)) * cityPrior : 0;
  const quality = shrunkRating >= 4.5 ? 96 : shrunkRating >= 4 ? 88 : shrunkRating >= 3.5 ? 76 : spot.staticPoiQuality === "较高" ? 88 : spot.staticPoiQuality === "一般" ? 68 : 58;
  const completeness = Math.min(100, 45 + (spot.sourceUrl ? 15 : 0) + (spot.lat && spot.lng ? 20 : 0) + (spot.extract ? 12 : 0) + (spot.openingHours ? 8 : 0));
  const rawSeason = spot.seasonality?.score == null ? 50 : Number(spot.seasonality.score);
  const seasonConfidence = spot.seasonality?.score == null ? 0 : Number(spot.seasonality?.confidence || 0.55);
  const season = 50 + (rawSeason - 50) * seasonConfidence;
  const crowdRiskScore = spot.crowd?.score == null ? 50 : Number(spot.crowd.score);
  const avoidCrowd = profile.crowdSensitivity === "high" || (profile.avoid || []).some((item: string) => /拥挤|人流/.test(item));
  const crowdFit = avoidCrowd ? 100 - crowdRiskScore : 55;
  const required = Boolean(spot.requiredByUser);
  const final = required ? 100 : Math.round(preference * 0.42 + quality * 0.2 + completeness * 0.16 + season * 0.12 + crowdFit * 0.1);
  return {
    final, required, matched,
    breakdown: {
      preference,
      poiQuality: quality,
      dataCompleteness: completeness,
      seasonality: season,
      crowdFit,
      confidence: {
        preference: preferenceMatch.confidence,
        poiQuality: rating > 0 ? Math.min(0.92, 0.55 + Math.log10(ratingCount + 1) * 0.09) : 0.48,
        dataCompleteness: 0.9,
        seasonality: seasonConfidence,
        crowdFit: Number(spot.crowd?.confidence || 0.45),
      },
    },
    basis: "结构化偏好 42% · POI 质量 20% · 数据完整度 16% · 时令证据 12% · 拥挤适配 10%",
    preferenceContributions: preferenceMatch.contributions,
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
      return { ...spot, plannerScore: score.final, scoreBreakdown: score.breakdown, scoreBasis: score.basis, preferenceContributions: score.preferenceContributions, matchedPreferences: score.matched, recommendationReasons: [...new Set(recommendationReasons)].slice(0, 4) };
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
      spot: { ...spot, openingHours },
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
factObservations.crowd = [{ value: { score: crowd.score, label: crowd.label, crowdRiskScore: crowd.crowdRiskScore, factors: crowd.factors, factorContributions: crowd.factorContributions, forecastBand: crowd.forecastBand, confidenceLabel: crowd.confidenceLabel, evidenceCoverage: crowd.evidenceCoverage, timeWindows: crowd.timeWindows, recommendedWindow: crowd.recommendedWindow, secondaryRecommendedWindow: crowd.secondaryRecommendedWindow, recommendedWindows: crowd.recommendedWindows, avoidWindow: crowd.avoidWindow, peakWindow: crowd.peakWindow, dataQualityNote: crowd.dataQualityNote, modelVersion: crowd.modelVersion, officialRealtime: false }, confidence: crowd.confidence, source: { id: `source-${spot.id}-crowd-model`, name: "Crowd Risk v2 多源风险模型", type: "prediction", url: crowdSourceUrl, fetchedAt, quality: "predicted" } }];
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

export function transitFare(value: any): number | null {
  const raw = value?.fare ?? value?.price ?? value?.transit_fee ?? value?.cost?.transit_fee ?? value?.cost?.fare ?? value?.cost?.price;
  const number = Number(raw);
  // Amap commonly uses 0 when the transit response has no fare data. Public
  // transport is not therefore verified as free; let the cost model estimate
  // from the routed distance unless a positive fare was actually returned.
  return Number.isFinite(number) && number > 0 ? number : null;
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
        fare: transitFare(transit),
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
      distanceM: Number(transit.distance || 0) || null, fare: transitFare(transit), source: "高德地图 MCP",
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
    const startMinute = timeToMinutes(block.startTime, 9 * 60);
    const timeBucket = `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:00-${String(Math.floor(startMinute / 60) + 1).padStart(2, "0")}:00`;
    const weekdayClass = /六|日/.test(weekday(day.date)) ? "weekend" : "weekday";
    const mode = cleanText(block.mode, "transit");
    const key = `${Number(from.lng).toFixed(5)},${Number(from.lat).toFixed(5)}->${Number(to.lng).toFixed(5)},${Number(to.lat).toFixed(5)}|${mode}|${weekdayClass}|${timeBucket}`;
    if (!exactCache.has(key)) exactCache.set(key, amapTransitFor(from, to, city, env));
    const result: any = await exactCache.get(key);
    if (result.status === "ready") {
      block.mcpTransport = result;
      if (result.durationMin) {
        block.durationMin = result.durationMin;
        block.source = result.source;
      block.quality = "verified";
      block.fetchedAt = result.fetchedAt;
      block.temporalProfile = { mode, weekday: weekdayClass, timeBucket };
      }
      if (result.fare != null) block.fare = result.fare;
    } else block.mcpStatus = result;
  }));
}

export function reflowDayAfterTransit(day: any, profile: any) {
  let originalActivities = (day.blocks || [])
    .filter((block: any) => block.type !== "leg")
    .sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
  const legByPair = new Map((day.blocks || []).filter((block: any) => block.type === "leg").map((block: any) => [`${block.from}->${block.to}`, block]));
  const projectedEndAfterTransit = (activities: any[]) => {
    let projectedCursor = timeToMinutes(profile.dayStart, 540);
    let previousProjectedSpot: any = null;
    for (const block of activities) {
      const originalStart = timeToMinutes(block.startTime, projectedCursor);
      const originalEnd = timeToMinutes(block.endTime, originalStart + Number(block.durationMin || 0));
      const duration = originalEnd > originalStart ? originalEnd - originalStart : Math.max(15, Number(block.durationMin || 0));
      const currentSpot = block.item || null;
      const leg: any = currentSpot && previousProjectedSpot ? legByPair.get(`${previousProjectedSpot.name}->${currentSpot.name}`) : null;
      projectedCursor = Math.max(originalStart, projectedCursor + Number(leg?.durationMin || 0)) + duration;
      if (currentSpot) previousProjectedSpot = currentSpot;
    }
    return projectedCursor;
  };
  const projectedEnd = projectedEndAfterTransit(originalActivities);
  const hasDinner = originalActivities.some((block: any) => block.mealType === "dinner");
  if (projectedEnd > 18 * 60 && !hasDinner) {
    const nearby = [...originalActivities].reverse().find((block: any) => block.item && timeToMinutes(block.endTime, 0) <= 18 * 60)
      || originalActivities.find((block: any) => block.item && timeToMinutes(block.startTime, 0) >= 18 * 60);
    originalActivities = [...originalActivities, {
      type: "rest", mealType: "dinner", label: "晚餐与休息", startTime: "17:30", endTime: "18:30", durationMin: 60,
      anchor: nearby?.item ? { lat: nearby.item.lat, lng: nearby.item.lng } : undefined,
      reason: "最终交通核验发现当天延续到 18:00 后，自动保留顺路晚餐时段",
    }].sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
  }
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
  let trimmedActivityMinutes = 0;
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
  if (overflow > 0) {
    const candidates = rebuilt.map((block: any, index: number) => ({ block, index }))
      .filter(({ block }: any) => block.type === "attraction" && block.item)
      .sort((left: any, right: any) => Number(Boolean(left.block.item?.requiredByUser)) - Number(Boolean(right.block.item?.requiredByUser)) || right.index - left.index);
    for (const { block, index } of candidates) {
      if (overflow <= 0) break;
      const minimumDuration = block.item?.requiredByUser ? 60 : 45;
      const available = Math.max(0, Number(block.durationMin || 0) - minimumDuration);
      const reduction = Math.min(overflow, available);
      if (!reduction) continue;
      block.durationMin -= reduction;
      block.endTime = minutesToTime(timeToMinutes(block.endTime, 0) - reduction);
      block.item.durationMin = block.durationMin;
      block.item.endTime = block.endTime;
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
      trimmedActivityMinutes += reduction;
    }
  }
  if (overflow > 0) {
    const removable = [...rebuilt].reverse().find((block: any) => block.type === "attraction" && block.item && !block.item.requiredByUser);
    if (removable) {
      day.blocks = rebuilt.filter((block: any) => block !== removable);
      day.finalTransitAdjustment = {
        type: "deterministic-micro-repair",
        removedSpotId: removable.item.id,
        removedSpotName: removable.item.name,
        reason: "最终交通核验后仍超出返程上限，移除末端最低优先级非必去节点；未改变必去点和用餐。",
      };
      reflowDayAfterTransit(day, profile);
      return;
    }
  }
  if (trimmedActivityMinutes) day.finalTransitAdjustment = { type: "minor-overflow-compression", trimmedActivityMinutes, reason: "最终公交核验后压缩少量景点停留时间，保留用餐、必选点与用户返程上限" };
  const conflicts: string[] = [];
  if (cursor > dayEnd) conflicts.push(`最终公交核验后结束时间 ${minutesToTime(cursor)} 超出用户要求 ${minutesToTime(dayEnd)}`);
  const lunch = originalActivities.find((block: any) => block.mealType === "lunch");
  if (!lunch || timeToMinutes(lunch.startTime, 0) > 13 * 60 + 30) conflicts.push("最终公交核验后午餐不在 13:30 前开始");
  const dinnerRequired = cursor > 18 * 60;
  const dinner = originalActivities.find((block: any) => block.mealType === "dinner");
  if (dinnerRequired && (!dinner || timeToMinutes(dinner.startTime, 0) > 20 * 60)) conflicts.push("最终公交核验后缺少合理晚餐时段");
  const duplicateNames = day.items.map((item: any) => normalizeName(item.name)).filter((name: string, index: number, values: string[]) => values.indexOf(name) !== index);
  if (duplicateNames.length) conflicts.push("最终时间轴存在重复景点");
  for (const item of day.items) {
    const start = timeToMinutes(item.startTime, 0);
    const end = timeToMinutes(item.endTime, start);
    const open = openingRange(item.openingHours);
    if (open && (start < open[0] || end > open[1])) conflicts.push(`${item.name} 在最终交通顺延后与地图常规开放时间冲突`);
    if (item.timeRole === "nightscape" && start < timeToMinutes(day.weather?.sunset, 18 * 60) + 25) conflicts.push(`${item.name} 在最终交通顺延后早于民用暮光时段`);
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

function transitEstimateBreakdown(distanceM: number) {
  if (distanceM <= 1200) {
    const walk = Math.max(8, Math.round(distanceM / 75));
    return { access: walk, waiting: 0, riding: 0, transfers: 0, egress: 0, total: walk, method: "walkable-distance" };
  }
  const access = Math.min(12, Math.max(5, Math.round(distanceM / 2200)));
  const waiting = distanceM > 12_000 ? 8 : 6;
  const riding = Math.max(4, Math.round(distanceM * 1.12 / 430));
  const transfers = distanceM > 16_000 ? 9 : distanceM > 7_000 ? 5 : 0;
  const egress = Math.min(10, Math.max(4, Math.round(distanceM / 2800)));
  return { access, waiting, riding, transfers, egress, total: access + waiting + riding + transfers + egress, method: "access+wait+ride+transfer+egress" };
}

function transitEstimate(distanceM: number) {
  return transitEstimateBreakdown(distanceM).total;
}

function withTransitUncertainty(leg: any) {
  const expected = Math.max(1, Number(leg.durationMin || 1));
  const verified = leg.quality === "verified";
  const routed = leg.quality === "routed";
  const spread = verified ? 0.12 : routed ? 0.22 : 0.35;
  return {
    ...leg,
    expected,
    p80: Math.ceil(expected * (1 + spread)),
    p95: Math.ceil(expected * (1 + spread * 1.75)),
    min: Math.max(1, Math.floor(expected * (1 - spread * 0.45))),
    confidence: verified ? 0.9 : routed ? 0.76 : 0.55,
  };
}

function sparseTrafficLegs(nodes: any[], legs: any[], requiredIds = new Set<string>(), neighbors = 4) {
  const kept = new Map<string, any>();
  const add = (leg: any) => kept.set(`${leg.fromId}->${leg.toId}`, withTransitUncertainty(leg));
  for (const leg of legs) {
    if (leg.fromId === "hotel" || leg.toId === "hotel" || requiredIds.has(leg.fromId) || requiredIds.has(leg.toId)) add(leg);
  }
  for (const node of nodes) {
    legs.filter((leg: any) => leg.fromId === node.id)
      .sort((left: any, right: any) => Number(left.distanceM || Number.MAX_SAFE_INTEGER) - Number(right.distanceM || Number.MAX_SAFE_INTEGER))
      .slice(0, neighbors)
      .forEach(add);
  }
  return [...kept.values()];
}

function fallbackMatrix(nodes: any[], fetchedAt: string, publicTransit = false) {
  const legs: any[] = [];
  for (let fromIndex = 0; fromIndex < nodes.length; fromIndex += 1) {
    for (let toIndex = 0; toIndex < nodes.length; toIndex += 1) {
      if (fromIndex === toIndex) continue;
      const distanceM = Math.round(haversine(nodes[fromIndex].lat, nodes[fromIndex].lng, nodes[toIndex].lat, nodes[toIndex].lng) * 1.25);
      legs.push({
        fromId: nodes[fromIndex].id, toId: nodes[toIndex].id,
        durationMin: publicTransit ? transitEstimate(distanceM) : estimatedRoadMinutes(distanceM),
        distanceM,
        source: publicTransit ? "公共交通距离模型（等待高德精确段）" : "坐标距离×1.25 透明估算",
        quality: "estimated", fetchedAt,
        ...(publicTransit ? { transitComponents: transitEstimateBreakdown(distanceM) } : {}),
      });
    }
  }
  const sparse = sparseTrafficLegs(nodes, legs);
  return { source: publicTransit ? "公共交通稀疏距离图（等待高德精确段）" : "坐标距离稀疏图×1.25 透明估算", fetchedAt, quality: "estimated", graphPolicy: "hotel-required-knn-lazy", totalPossibleLegs: legs.length, nodes, legs: sparse, verifiedLegCount: 0 };
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
  const candidatePool = uniqueSpots([
    ...spots.filter((spot: any) => spot.requiredByUser),
    ...spots.filter((spot: any) => !spot.requiredByUser),
  ]).filter((spot: any) => Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lng)));
  const requiredCandidates = candidatePool.filter((spot: any) => spot.requiredByUser);
  const optionalCapacity = Math.max(0, 48 - requiredCandidates.length);
  const selected = uniqueSpots([...requiredCandidates, ...candidatePool.filter((spot: any) => !spot.requiredByUser).slice(0, optionalCapacity)]);
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
        ...(publicTransit ? { transitComponents: transitEstimateBreakdown(distanceM) } : {}),
      });
    }));
    if (legs.length < nodes.length * (nodes.length - 1) * 0.8) throw new Error("OSRM 矩阵缺失过多");
    const nodeById = new Map(nodes.map((node: any) => [node.id, node]));
    const requiredIds = new Set(selected.filter((spot: any) => spot.requiredByUser).map((spot: any) => spot.id));
    const sparseLegs = sparseTrafficLegs(nodes, legs, requiredIds);
    if (!publicTransit) return { source: "OSRM Table 稀疏道路图", fetchedAt, quality: "routed", graphPolicy: "hotel-required-knn-lazy", totalPossibleLegs: legs.length, nodes, legs: sparseLegs, verifiedLegCount: sparseLegs.length };

    const directed = legs
      .filter((leg: any) => leg.fromId === "hotel" || leg.toId === "hotel" || requiredIds.has(leg.fromId) || requiredIds.has(leg.toId))
      .sort((left: any, right: any) => left.distanceM - right.distanceM)
      .slice(0, 14);
    const nearest = nodes.flatMap((node: any) => legs
      .filter((leg: any) => leg.fromId === node.id && leg.toId !== "hotel")
      .sort((left: any, right: any) => left.distanceM - right.distanceM)
      .slice(0, 2));
    const pairKeys = new Set<string>();
    const riskDrivenCap = profile.deepReasoning === false
      ? Math.max(3, Math.min(10, 3 + requiredIds.size * 2 + Math.ceil(Number(profile.days || 1) / 2)))
      : Math.max(5, Math.min(18, 5 + requiredIds.size * 2 + Number(profile.days || 1)));
    const queryLegs = [...directed, ...nearest].filter((leg: any) => {
      const key = `${leg.fromId}->${leg.toId}`;
      if (pairKeys.has(key)) return false;
      pairKeys.add(key);
      return true;
    }).map((leg: any) => ({
      ...leg,
      edgeRiskScore: (leg.fromId === "hotel" || leg.toId === "hotel" ? 25 : 0)
        + (requiredIds.has(leg.fromId) || requiredIds.has(leg.toId) ? 40 : 0)
        + Math.min(25, Number(leg.distanceM || 0) / 1500)
        + (leg.quality === "estimated" ? 15 : 5),
    })).sort((left: any, right: any) => right.edgeRiskScore - left.edgeRiskScore).slice(0, riskDrivenCap);
    const exact = await mapWithConcurrency(queryLegs, 4, async (leg: any) => ({
      leg,
      result: await amapTransitFor(nodeById.get(leg.fromId), nodeById.get(leg.toId), city, env),
    }));
    let verifiedLegCount = 0;
    for (const settled of exact) {
      if (settled.status !== "fulfilled" || settled.value.result?.status !== "ready" || !settled.value.result.durationMin) continue;
      const target = sparseLegs.find((leg: any) => leg.fromId === settled.value.leg.fromId && leg.toId === settled.value.leg.toId);
      if (!target) continue;
      target.durationMin = settled.value.result.durationMin;
      target.distanceM = settled.value.result.distanceM || target.distanceM;
      target.source = `${settled.value.result.source}（规划前）`;
      target.quality = "verified";
      target.fetchedAt = settled.value.result.fetchedAt || fetchedAt;
      Object.assign(target, withTransitUncertainty(target));
      verifiedLegCount += 1;
    }
    return {
      source: verifiedLegCount ? `高德公交/地铁规划前核验 ${verifiedLegCount} 段 + 其余公共交通透明估算` : "公共交通距离模型（高德本轮未返回）",
      fetchedAt, quality: "estimated", graphPolicy: "hotel-required-knn-lazy", totalPossibleLegs: legs.length, nodes, legs: sparseLegs, verifiedLegCount,
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
    priceType: price ? "高德 POI 每晚每间最低参考价（非指定入住日期）" : "高德 POI 暂未返回参考价",
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
7. crowdRisk.score / crowdRisk.crowdRiskScore 是 0—100 风险分，不是统计概率，不是在园人数；relax 优先低风险时段，必去点不可因此删除。hotness 仅表示近期关注度，seasonFit 仅表示时令适配，二者必须分别用于经典/摄影方案排序。
8. openingAlert 不等于已确认闭园，但必须在调整条件中提示用户核对原文；若候选点存在同类替代点，应给出 alternativeSpotIds。
9. 推荐理由必须简短并引用 evidenceRefs；每个景点要提供交通方式、矩阵耗时、调整条件和候选池内替代点。
10. 必须服从每个候选点的 timeRole、preferredWindows、avoidWindows 与 timeRationale：meal-landmark 必须用 type=meal 且保留 spotId，安排在 11:30—13:30 或 17:30—20:00；nightscape 必须在当日 sunset 后；展馆服从开放与预约；户外摄影优先早晚光线。
11. 每日必须包含正常午餐；若当天延续到 18:00 后还必须包含晚餐。活动之间不得重叠，交通时间不能被吞掉，午晚餐不是可删除的装饰块。
12. 每套天数严格等于 profile.days。若调用方要求三套，则输出 hot、niche、relax 且顺序不变；若明确要求“本次只生成某一套”，variants 必须只含该套，不能擅自输出另外两套。
13. profile.budget 是真实用户约束。存在门票、酒店参考价或交通成本证据时，优先减少不必要收费点、选择公共交通并聚类路线以降低跨区成本；不得删除 requiredByUser 景点。若预算与必去、人数、住宿等硬要求冲突，必须在 strategy 或 adjustmentCondition 中明确说明，不得编造低价来假装满足预算。最终金额由后端确定性计算，模型不得自行加总或创造价格。结构示例：${JSON.stringify(PLANNER_JSON_EXAMPLE)}`;

async function generatePlannerDraft(profile: any, knowledge: any, env: any, replanContext: any) {
  assertPlannerContext(knowledge);
  const modelAudit = { plannerModel: aiPrimaryModel(env, "planner"), repairModel: aiPrimaryModel(env, "repair"), toolCalls: [] as any[], formatRepairs: 0, repairRounds: 0, deepReasoningUsed: profile.deepReasoning !== false, degraded: false, degradationReason: "", compilerIssues: [] as any[], feasibilityPrecheck: null as any };
  const feasibility = precheckRouteFeasibility({ profile, knowledge });
  modelAudit.feasibilityPrecheck = feasibility;
  if (!feasibility.feasible) {
    throw new Error(`用户硬约束当前不可行：${feasibility.violations.map((item) => item.message).join("；")}。请减少必去项、延长每日时段或调整日期后重试。`);
  }
  let draft: any;
  const objectives = [
    { id: "hot", name: "经典覆盖", goal: "优先代表性与必去覆盖，控制跨区移动；在预算内优先有证据的经典点。" },
    { id: "niche", name: "自然摄影", goal: "优先自然、摄影、季节证据和合理光线；同等体验优先免费或低费用地点。" },
    { id: "relax", name: "轻松避峰", goal: "降低每日景点数、增加缓冲；优先公共交通和少跨区路线以控制费用。" },
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
  const plannerInput = { task: replanContext ? "局部重规划" : "首次规划", objectives, knowledge: compactPlannerKnowledge(knowledge), verifiedWebContext, replanContext };
  let decisionMemo = "";
  if (profile.deepReasoning !== false) {
    try {
      const deliberation = await aiRequest(env, {
        purpose: "planner", thinking: true, allowReasoningOnly: true, maxTokens: 1200, requestTimeoutMs: 45000,
        messages: [
          { role: "system", content: "你是资深旅行行程决策器。先深度分析约束，只需给后续成稿模型一份精炼决策备忘录，不输出完整 JSON。重点判断必去覆盖、餐饮型地点饭点、夜景日落后时段、开放时间、天气、交通间隔、午晚餐、缓冲和三方案差异。不得添加输入中没有的事实。" },
          { role: "user", content: JSON.stringify(plannerInput) },
        ],
      });
      decisionMemo = cleanText(deliberation.content || deliberation.reasoningContent).slice(0, 6000);
    } catch (error: any) {
      modelAudit.compilerIssues.push({ code: "DEEP_REASONING_BUDGET", message: `规划模型的深度分析未在 45 秒预算内形成备忘录，继续成稿并接受编译器校验：${cleanText(error?.message)}` });
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
          { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n后端已完成联网取证，verifiedWebContext、天气和交通矩阵均在输入中。本次只生成 ${objective.id}=${objective.goal} 这一套方案，仍须覆盖所有必去点和全部旅行日期。输出 {"variants":[一套完整方案]}，不得输出另外两套。${decisionMemo ? `\n共享 AI 决策备忘录（不是新增事实）：\n${decisionMemo}` : ""}` },
          { role: "user", content: JSON.stringify({ ...plannerInput, objective, existingVariantSummaries: draft.variants.map((variant: any) => ({ id: variant.id, strategy: variant.strategy, spotIds: variant.days.flatMap((day: any) => day.activities.map((activity: any) => activity.spotId).filter(Boolean)) })), instruction: `只输出 ${objective.id} 的完整 JSON 方案，并与已有方案形成实质差异。` }) },
        ],
      });
      const variant = normalizePlannerVariant(supplemental.value, profile, variantIndex);
      if (!variant?.days?.length) throw new Error(`${objective.id} 没有返回完整日期`);
      draft.variants.push(variant);
      modelAudit.plannerModel = supplemental.model;
      if (supplemental.formatRepaired) modelAudit.formatRepairs += 1;
    } catch (error: any) {
      throw new Error(`规划模型未能补全 ${objective.name} 方案：${cleanText(error?.message, "规划模型调用失败")}`);
    }
  }
  if (draft.variants.length !== 3) throw new Error(`规划模型未能生成可靠时间轴：最终只有 ${draft.variants.length} 套方案`);
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
    throw new Error(`规划模型经 ${modelAudit.repairRounds} 轮修复后仍有 ${audit.hardIssues.length} 个时间或约束冲突，系统拒绝返回低质量算法拼接行程${summary ? `。主要问题：${summary}` : ""}`);
  }
  return { draft, audit, modelAudit };
}

const WORKFLOW_OBJECTIVES = [
  { id: "hot", name: "经典覆盖", goal: "优先代表性与必去覆盖，控制跨区移动；不要把购物 POI 当景点；在预算内优先有证据的经典点。" },
  { id: "niche", name: "自然摄影", goal: "优先自然、摄影、季节证据和合理光线；恶劣天气给候选池内室内替代；同等体验优先免费或低费用地点。" },
  { id: "relax", name: "轻松避峰", goal: "降低每日景点数、增加缓冲；客流未知时不得宣称实时避峰成功；优先公共交通和少跨区路线以控制费用。" },
];

export function shouldRecoverPlannerImmediately(error: unknown) {
  const message = cleanText(error instanceof Error ? error.message : error);
  if (isAiRateLimited(error)) return false;
  return /模型均不可用/.test(message)
    && /\[(?:MODEL_NOT_FOUND|UNAUTHORIZED)\]/.test(message);
}

function newWorkflowPlannerState(profile: any, env: any) {
  return {
    verifiedWebContext: [], research: null, decisionMemo: "", draft: { variants: [] }, audit: null,
    modelAudit: { researchModel: aiPrimaryModel(env, "research"), plannerModel: aiPrimaryModel(env, "planner"), criticModel: aiPrimaryModel(env, "critic"), repairModel: aiPrimaryModel(env, "repair"), planningMode: "ai_optimized", criticStatus: "pending", criticIssues: [], toolCalls: [], formatRepairs: 0, repairRounds: 0, deepReasoningUsed: profile.deepReasoning !== false, degraded: false, degradationReason: "", compilerIssues: [], feasibilityPrecheck: null },
  };
}

function researchContextForPlanner(research: any) {
  if (!research) return { status: "not-run", facts: [], skipped: [] };
  return {
    status: research.modelStatus,
    facts: list(research.facts).map((fact: any) => ({
      targetId: fact.targetId, questionType: fact.questionType, status: fact.status,
      value: fact.value, confidence: fact.confidence, sourceTier: fact.sourceTier,
      validFrom: fact.validFrom, validTo: fact.validTo, evidenceIds: fact.supportingEvidenceIds,
    })),
    metrics: research.metrics,
    unresolvedGaps: list(research.gaps).filter((gap: any) => gap.currentStatus === "unknown" || gap.currentStatus === "conflicting").map((gap: any) => ({ id: gap.id, targetName: gap.targetName, questionType: gap.factType, priority: researchUtility(gap) })),
    skipped: research.skipped,
  };
}

async function runPlannerWorkflowStage(stage: string, profile: any, knowledge: any, env: any, replanContext: any, previousState?: any, retryContext?: any) {
  assertPlannerContext(knowledge);
  if (knowledge.constraintModel?.conflicts?.length) {
    throw new Error(`用户硬约束互相冲突：${knowledge.constraintModel.conflicts.map((item: any) => item.reason).join("；")}`);
  }
  const state = previousState || newWorkflowPlannerState(profile, env);
  const effectiveKnowledge = applyResearchFactsToKnowledge(knowledge, state.research);
  if ((stage === "planner_memo" || stage.startsWith("variant_")) && !state.modelAudit.feasibilityPrecheck) {
    const feasibility = precheckRouteFeasibility({ profile, knowledge: effectiveKnowledge });
    state.modelAudit.feasibilityPrecheck = feasibility;
    if (!feasibility.feasible) {
      throw new Error(`用户硬约束当前不可行：${feasibility.violations.map((item: any) => item.message).join("；")}。最小冲突集：${feasibility.minimalConflictSet.join("、")}。请减少必去项、延长每日时段或调整日期后重试。`);
    }
  }
  const plannerInput = { task: replanContext ? "局部重规划" : "首次规划", objectives: WORKFLOW_OBJECTIVES, knowledge: compactPlannerKnowledge(effectiveKnowledge), research: researchContextForPlanner(state.research), verifiedWebContext: state.verifiedWebContext, replanContext };
  if (stage === "planner_research") {
    state.research = await runResearchAgent(profile, knowledge, env);
    state.modelAudit.researchModel = state.research.model;
    state.verifiedWebContext = list(state.research.searchExecutions).map((execution: any) => ({
      tool: "search_orchestrator", query: execution.request?.query, questionType: execution.request?.questionType,
      reason: execution.request?.reason, expectedDecisionImpact: execution.request?.expectedDecisionImpact,
      providers: execution.providersAttempted, providerFailures: execution.providerFailures, resultCount: execution.results?.length || 0, fetchedAt: execution.executedAt,
    }));
    state.modelAudit.toolCalls = state.verifiedWebContext;
    if (state.research.modelStatus !== "ready") {
      state.modelAudit.degraded = true;
      state.modelAudit.planningMode = "ai_assisted";
      state.modelAudit.degradationReason = [state.modelAudit.degradationReason, "Research Agent 模型不可用，已使用确定性缺口规划与多源检索继续取证"].filter(Boolean).join("；");
      state.modelAudit.compilerIssues.push({ code: "RESEARCH_MODEL_DEGRADED", severity: "warning", message: state.research.modelError || "Research Agent 未返回可用查询计划" });
    }
    return state;
  }
  if (stage === "planner_memo") {
    if (profile.deepReasoning === false) {
      state.modelAudit.compilerIssues.push({ code: "DEEP_REASONING_SKIPPED", severity: "info", message: "用户关闭深度思考，已跳过决策备忘录阶段；联网研究与硬约束校验仍执行" });
      return state;
    }
    try {
      const deliberation = await aiRequest(env, {
        purpose: "planner", thinking: true, allowReasoningOnly: true, maxTokens: 1200, requestTimeoutMs: 150000,
        messages: [
          { role: "system", content: "你是资深旅行行程决策器。形成精炼决策备忘录，不输出完整 JSON。重点判断必去覆盖、餐饮型地点饭点、夜景日落后时段、开放时间、天气、交通间隔、午晚餐、缓冲和三方案差异。不得添加输入中没有的事实。" },
          { role: "user", content: JSON.stringify({ ...plannerInput, verifiedWebContext: state.verifiedWebContext }) },
        ],
      });
      state.decisionMemo = cleanText(deliberation.content || deliberation.reasoningContent).slice(0, 6000);
    } catch (error: any) {
      if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
      state.modelAudit.compilerIssues.push({ code: "DEEP_REASONING_BUDGET", message: `规划模型的深度分析未形成备忘录，继续由可用模型成稿：${cleanText(error?.message)}` });
    }
    return state;
  }
  if (stage.startsWith("variant_")) {
    // V2 兼容说明：旧流程以 maxTokens: 5400 生成完整时间表，并在“结构校验失败后的最后一次定向重试”中修补；
    // V3 改为短骨架 + 确定性编译器。若明确要求“本次只生成某一套”，仍由独立 D1 stage 隔离该方案。
    const variantId = stage.slice("variant_".length);
    const variantIndex = WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === variantId);
    const objective = WORKFLOW_OBJECTIVES[variantIndex];
    if (!objective) throw new Error(`未知方案阶段：${stage}`);
    if (state.draft.variants.some((variant: any) => variant.id === variantId)) return state;
    let supplemental: any = null;
    const previousVariantSpotIds = state.draft.variants.flatMap((item: any) => item.days.flatMap((day: any) => day.activities.map((activity: any) => activity.spotId).filter(Boolean)));
    const deterministicBase = recoverPlannerVariant(profile, effectiveKnowledge, variantIndex, null, "确定性优化器生成初始可行骨架", previousVariantSpotIds);
    let variant: any = deterministicBase;
    let failure = "";
    try {
      supplemental = await aiJson(env, {
        purpose: "planner", thinking: false, maxTokens: 1800, requestTimeoutMs: 150000,
        messages: [
          { role: "system", content: `你是旅行偏好与策略决策器，不是排程器。事实、精确分钟、开放窗、交通、用餐与硬约束由后端优化器决定。你只能从候选池选择 spotId，并说明高层策略，不得创造事实或时间。为 ${objective.id}=${objective.goal} 输出严格 JSON：{"skeleton":{"title":"","style":"","strategy":"","selectedSpotIds":[],"dayThemes":[]}}。selectedSpotIds 必须包含全部 requiredByUser=true 的 ID，并与已有方案保持体验差异。${state.decisionMemo ? `\n共享决策备忘录（不是新增事实）：\n${state.decisionMemo}` : ""}` },
          { role: "user", content: JSON.stringify({ ...plannerInput, verifiedWebContext: state.verifiedWebContext, objective, optimizerProposal: { title: deterministicBase.title, days: deterministicBase.days.map((day: any) => ({ day: day.day, theme: day.theme, spotIds: day.activities.map((activity: any) => activity.spotId).filter(Boolean) })) }, existingVariantSummaries: state.draft.variants.map((item: any) => ({ id: item.id, strategy: item.strategy, spotIds: item.days.flatMap((day: any) => day.activities.map((activity: any) => activity.spotId).filter(Boolean)) })), instruction: `确定性优化器已给出可行骨架。只做 ${objective.id} 的高层候选偏好调整和策略解释，不输出分钟级时间表。` }) },
        ],
      });
      const skeleton = normalizePlannerSkeleton(supplemental.value, profile, variantIndex);
      variant = recoverPlannerVariant(profile, effectiveKnowledge, variantIndex, skeleton, "确定性优化器根据 AI 高层候选策略生成可执行时间线", previousVariantSpotIds);
      variant.strategy = cleanText(skeleton.strategy, variant.strategy);
    } catch (error: any) {
      if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
      failure = cleanText(error?.message, `${objective.name}模型调用失败`);
      if (!retryContext?.attempts && !shouldRecoverPlannerImmediately(error)) throw new Error(failure);
      variant = deterministicBase;
      variant.recoveryReason = failure;
      state.modelAudit.degraded = true;
      state.modelAudit.planningMode = "deterministic_recovery";
      const recoveryReason = shouldRecoverPlannerImmediately(error) ? "模型不存在或鉴权不可用" : `在 ${Number(retryContext?.attempts || 0) + 1} 次阶段尝试后仍未获得可编译方案`;
      state.modelAudit.degradationReason = [state.modelAudit.degradationReason, `${objective.name}${recoveryReason}，已保留候选池事实并由可靠性编译器补全时间轴`].filter(Boolean).join("；");
      state.modelAudit.compilerIssues.push({ code: "MODEL_STRUCTURE_RECOVERED", severity: "warning", variantId, message: `${failure}；未切换到较弱模型，未新增候选池外事实` });
    }
    state.draft.variants.push(variant);
    state.draft.variants.sort((left: any, right: any) => WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === left.id) - WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === right.id));
    if (supplemental?.model) state.modelAudit.plannerModel = supplemental.model;
    if (supplemental?.formatRepaired) state.modelAudit.formatRepairs += 1;
    return state;
  }
  if (stage === "critic_review") {
    const coverageRepair = enforceRequiredCoverage(state.draft, effectiveKnowledge);
    if (coverageRepair.changes.length) state.modelAudit.compilerIssues.push({
      code: "REQUIRED_COVERAGE_ENFORCED", severity: "warning",
      message: `硬约束编译器在 Critic 前修复 ${coverageRepair.replaced} 个模型遗漏的必选绑定${coverageRepair.rebuilt ? `，并重建 ${coverageRepair.rebuilt} 套无法局部修复的方案` : ""}`,
      changes: coverageRepair.changes,
    });
    bindTrafficMatrixFacts(state.draft, effectiveKnowledge);
    const deterministicAudit = auditPlannerDraft(state.draft, effectiveKnowledge);
    const semanticCriticNeeded = deterministicAudit.hardIssues.length === 0
      && (list(profile.preferences).length > 0 || list(profile.avoid).length > 0 || deterministicAudit.differences.maxJaccard > 0.75);
    if (!semanticCriticNeeded) {
      state.modelAudit.criticStatus = "skipped-structural-repair-first";
      state.modelAudit.compilerIssues.push({ code: "AI_CRITIC_SKIPPED", severity: "info", message: "确定性审计已发现结构问题，先进入确定性修复层；未为可程序判断的问题消耗 Critic 调用。" });
      return state;
    }
    try {
      const critique = await aiJson(env, {
        purpose: "critic", thinking: profile.deepReasoning !== false, maxTokens: 2200, requestTimeoutMs: 120000,
        messages: [
          { role: "system", content: "你是独立旅行方案 Structured Critic。确定性程序已经负责时间重叠、开放窗、交通间隔、饭点和必去覆盖；你只检查偏好违背、体验重复、方案风格不一致、天气语义和解释是否误用证据。不得补充新事实。只输出 JSON：{issues:[{target,type,severity,evidenceRef,proposedAction,confidence,message,variantId}]}。target 必须是现有 spotId、dayId 或 variantId；severity 仅 warning/info。" },
          { role: "user", content: JSON.stringify({ profile: effectiveKnowledge.profile, draft: state.draft, deterministicIssues: deterministicAudit.issues, research: researchContextForPlanner(state.research), trafficMatrix: effectiveKnowledge.trafficMatrix }) },
        ],
      });
      state.modelAudit.criticModel = critique.model;
      state.modelAudit.criticStatus = "ready";
      state.modelAudit.criticIssues = list(critique.value?.issues).slice(0, 40).map((issue: any) => ({
        target: cleanText(issue.target),
        variantId: cleanText(issue.variantId),
        code: cleanText(issue.type || issue.code, "AI_CRITIC_NOTE"),
        severity: ["warning", "info"].includes(cleanText(issue.severity)) ? cleanText(issue.severity) : "warning",
        message: cleanText(issue.message),
        suggestedRepair: cleanText(issue.proposedAction || issue.suggestedRepair),
        evidenceIds: [...new Set([cleanText(issue.evidenceRef), ...list(issue.evidenceIds)].filter(Boolean))].slice(0, 8),
        confidence: Math.max(0, Math.min(1, Number(issue.confidence || 0.5))),
      })).filter((issue: any) => issue.message);
    } catch (error: any) {
      if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
      state.modelAudit.criticStatus = "deterministic-only";
      state.modelAudit.planningMode = state.modelAudit.planningMode === "deterministic_recovery" ? state.modelAudit.planningMode : "ai_assisted";
      state.modelAudit.compilerIssues.push({ code: "AI_CRITIC_UNAVAILABLE", severity: "warning", message: `独立 AI Critic 不可用，确定性审计继续执行：${cleanText(error?.message)}` });
    }
    return state;
  }
  if (stage.startsWith("audit_")) {
    if (state.draft.variants.length !== 3) throw new Error(`规划模型方案检查点不完整：${state.draft.variants.length}/3`);
    const coverageRepair = enforceRequiredCoverage(state.draft, effectiveKnowledge);
    if (coverageRepair.changes.length) state.modelAudit.compilerIssues.push({
      code: "REQUIRED_COVERAGE_REENFORCED", severity: "warning", stage,
      message: `AI 修复后再次补回 ${coverageRepair.replaced} 个必选绑定${coverageRepair.rebuilt ? `，重建 ${coverageRepair.rebuilt} 套方案` : ""}`,
      changes: coverageRepair.changes,
    });
    bindTrafficMatrixFacts(state.draft, effectiveKnowledge);
    const legalization = legalizePlannerTimelines(state.draft, effectiveKnowledge);
    if (legalization.shiftedActivities) state.modelAudit.compilerIssues.push({ code: "TIMELINE_LEGALIZED", severity: "warning", message: `Travel Compiler 按交通矩阵顺延 ${legalization.shiftedActivities} 个节点，共 ${legalization.shiftedMinutes} 分钟` });
    state.audit = auditPlannerDraft(state.draft, effectiveKnowledge);
    if (stage === "audit_initial" && state.modelAudit.criticIssues?.length) {
      state.modelAudit.compilerIssues.push(...state.modelAudit.criticIssues.map((issue: any) => ({ ...issue, source: "ai-critic", severity: issue.severity === "hard" ? "warning" : issue.severity })));
    }
    if (stage === "audit_final") {
      const structuralCodes = new Set(state.audit.hardIssues.map((issue: any) => cleanText(issue.code)));
      if (structuralCodes.has("DUPLICATE_SPOT") || structuralCodes.has("VARIANTS_TOO_SIMILAR")) {
        let removedDuplicates = 0;
        for (const variant of state.draft.variants) {
          const seen = new Set<string>();
          for (const day of variant.days || []) {
            day.activities = (day.activities || []).filter((activity: any) => {
              const spotId = cleanText(activity.spotId);
              if (!spotId) return true;
              if (seen.has(spotId)) { removedDuplicates += 1; return false; }
              seen.add(spotId);
              return true;
            });
          }
        }
        state.audit = auditPlannerDraft(state.draft, effectiveKnowledge);
        const rebuiltVariants: string[] = [];
        if (state.audit.hardIssues.some((issue: any) => cleanText(issue.code) === "VARIANTS_TOO_SIMILAR")) {
          for (let variantIndex = 1; variantIndex < state.draft.variants.length; variantIndex += 1) {
            const previousVariantSpotIds = state.draft.variants.slice(0, variantIndex).flatMap((variant: any) => variant.days.flatMap((day: any) => day.activities.map((activity: any) => cleanText(activity.spotId)).filter(Boolean)));
            const current = state.draft.variants[variantIndex];
            state.draft.variants[variantIndex] = recoverPlannerVariant(profile, effectiveKnowledge, variantIndex, current, "两轮 AI 修复后方案差异仍不足，由多目标路线优化器执行确定性差异化", previousVariantSpotIds);
            rebuiltVariants.push(cleanText(current.id));
          }
        }
        enforceRequiredCoverage(state.draft, effectiveKnowledge);
        bindTrafficMatrixFacts(state.draft, effectiveKnowledge);
        legalizePlannerTimelines(state.draft, effectiveKnowledge);
        state.audit = auditPlannerDraft(state.draft, effectiveKnowledge);
        state.modelAudit.compilerIssues.push({ code: "FINAL_STRUCTURAL_REPAIR", severity: "warning", message: `最终编译器移除 ${removedDuplicates} 个重复景点节点${rebuiltVariants.length ? `，并对 ${rebuiltVariants.join("、")} 执行确定性差异化` : ""}；未放宽重复与方案差异硬约束` });
      }
      if (state.audit.hardIssues.some((issue: any) => ["MEAL_MISSING", "LUNCH_MISSING", "DINNER_MISSING", "TIME_RANGE", "ACTIVITY_OVERLAP", "TRANSIT_GAP", "RETURN_TOO_LATE"].includes(cleanText(issue.code)))) {
        const safetyRepair = applyFinalTimelineSafetyRepair(state.draft, effectiveKnowledge);
        bindTrafficMatrixFacts(state.draft, effectiveKnowledge);
        state.audit = auditPlannerDraft(state.draft, effectiveKnowledge);
        state.modelAudit.compilerIssues.push({ code: "FINAL_TIMELINE_SAFETY_REPAIR", severity: "warning", message: `最终编译器补齐午餐 ${safetyRepair.insertedLunches} 次、晚餐 ${safetyRepair.insertedDinners} 次，移除 ${safetyRepair.removedFlexibleStops} 个非必选超时节点，并按交通矩阵重排时间；AI 仍负责景点与方案决策` });
      }
      state.modelAudit.compilerIssues.push(...state.audit.issues);
      if (state.audit.hardIssues.length) {
        const summary = state.audit.hardIssues.slice(0, 8).map((issue: any) => `${cleanText(issue.code)}：${cleanText(issue.message)}`).join("；");
        throw new Error(`规划模型经两轮修复后仍有 ${state.audit.hardIssues.length} 个硬冲突${summary ? `：${summary}` : ""}`);
      }
    }
    return state;
  }
  if (stage.startsWith("repair_round_")) {
    if (!state.audit) state.audit = auditPlannerDraft(state.draft, effectiveKnowledge);
    if (!state.audit.hardIssues.length) return state;
    const beforeDeterministicRepair = state.audit.hardIssues.length;
    const coverageRepair = enforceRequiredCoverage(state.draft, effectiveKnowledge);
    bindTrafficMatrixFacts(state.draft, effectiveKnowledge);
    const legalization = legalizePlannerTimelines(state.draft, effectiveKnowledge);
    const safetyRepair = applyFinalTimelineSafetyRepair(state.draft, effectiveKnowledge);
    bindTrafficMatrixFacts(state.draft, effectiveKnowledge);
    state.audit = auditPlannerDraft(state.draft, effectiveKnowledge);
    state.modelAudit.compilerIssues.push({
      code: "DETERMINISTIC_REPAIR_LAYER",
      severity: state.audit.hardIssues.length ? "warning" : "info",
      stage,
      message: `确定性修复层先处理 ${beforeDeterministicRepair - state.audit.hardIssues.length}/${beforeDeterministicRepair} 个硬冲突：补回必去 ${coverageRepair.replaced + coverageRepair.rebuilt} 项、顺延 ${legalization.shiftedActivities} 个节点、补午餐 ${safetyRepair.insertedLunches} 次、补晚餐 ${safetyRepair.insertedDinners} 次、移除低价值超时节点 ${safetyRepair.removedFlexibleStops} 个。`,
    });
    if (!state.audit.hardIssues.length) return state;
    const affectedIds = new Set(state.audit.hardIssues.map((issue: any) => cleanText(issue.variantId)).filter(Boolean));
    if (!affectedIds.size) affectedIds.add("relax");
    for (const variantId of affectedIds) {
      const variantIndex = WORKFLOW_OBJECTIVES.findIndex((objective) => objective.id === variantId);
      if (variantIndex < 0 || !state.draft.variants[variantIndex]) continue;
      const issues = state.audit.hardIssues.filter((issue: any) => !issue.variantId || issue.variantId === variantId);
      try {
        const repaired = await aiJson(env, {
          purpose: "repair", thinking: false, maxTokens: 5600, requestTimeoutMs: 150000,
          messages: [
            { role: "system", content: `${PLANNER_SYSTEM_PROMPT}\n你是单方案冲突修复器。只输出 {"variants":[修复后的 ${variantId} 完整方案]}。逐项消除问题并保留必去点和正常用餐。` },
            { role: "user", content: JSON.stringify({ knowledge: compactPlannerKnowledge(effectiveKnowledge), research: researchContextForPlanner(state.research), variant: state.draft.variants[variantIndex], issues, hardConstraints: { requiredAttractions: profile.requiredAttractions, dayStart: profile.dayStart, dayEnd: profile.dayEnd, days: profile.days }, replanContext }) },
          ],
        });
        const repairedVariant = normalizePlannerVariant(repaired.value, profile, variantIndex);
        if (!completePlannerVariant(repairedVariant, profile)) throw new Error(`${variantId} 修复结果缺少完整日期`);
        state.draft.variants[variantIndex] = repairedVariant;
        state.modelAudit.repairModel = repaired.model;
        if (repaired.formatRepaired) state.modelAudit.formatRepairs += 1;
      } catch (error: any) {
        if (isAiRateLimited(error) || /TASK_CANCELLED|LEASE_LOST/.test(String(error))) throw error;
        if (!retryContext?.attempts && !shouldRecoverPlannerImmediately(error)) throw error;
        state.modelAudit.degraded = true;
        state.modelAudit.degradationReason = [state.modelAudit.degradationReason, `${variantId} 的 AI 冲突修复暂不可用，后续继续由硬约束编译器校验`].filter(Boolean).join("；");
        state.modelAudit.compilerIssues.push({ code: "AI_REPAIR_UNAVAILABLE", severity: "warning", variantId, message: cleanText(error?.message) });
      }
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
        item.factObservations = { ...item.factObservations, crowd: item.factObservations.crowd.map((observation: any, index: number) => index ? observation : { ...observation, value: { ...observation.value, score: item.crowd.score, crowdRiskScore: item.crowd.crowdRiskScore, label: item.crowd.label, factors: item.crowd.factors, factorContributions: item.crowd.factorContributions, forecastBand: item.crowd.forecastBand, confidenceLabel: item.crowd.confidenceLabel, evidenceCoverage: item.crowd.evidenceCoverage, timeWindows: item.crowd.timeWindows, recommendedWindow: item.crowd.recommendedWindow, secondaryRecommendedWindow: item.crowd.secondaryRecommendedWindow, recommendedWindows: item.crowd.recommendedWindows, avoidWindow: item.crowd.avoidWindow, peakWindow: item.crowd.peakWindow, action: item.crowd.action, dataQualityNote: item.crowd.dataQualityNote, visitAdvice: item.crowd.visitAdvice, visitTime: item.crowd.visitTime, visitDate: item.crowd.visitDate, modelVersion: item.crowd.modelVersion, officialRealtime: false } }) };
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
const WORKFLOW_STAGES = ["parse_profile", "collect_sources", "build_knowledge", "build_matrix", "planner_research", "planner_memo", "variant_hot", "variant_niche", "variant_relax", "critic_review", "audit_initial", "repair_round_1", "audit_round_1", "repair_round_2", "audit_final", "final_transit", "compile_result"];
const stageLabels: Record<string, string> = {
  parse_profile: "正在由需求理解模型整理关键信息", collect_sources: "正在并行获取天气、景点与住宿候选", build_knowledge: "正在核验必选实体、趋势、时令与拥挤风险", build_matrix: "正在建立透明交通候选矩阵", planner_research: "Research Agent 正在判断信息缺口并联网取证", planner_memo: "规划模型正在形成深度决策备忘录", variant_hot: "正在生成经典覆盖方案", variant_niche: "正在生成自然摄影方案", variant_relax: "正在生成轻松避峰方案", critic_review: "独立 Critic 正在审查三套路线", audit_initial: "正在执行第一轮硬约束审计", repair_round_1: "正在修复第一轮硬冲突", audit_round_1: "正在复核第一轮修复", repair_round_2: "正在进行最后一轮定向修复", audit_final: "正在执行最终硬约束审计", final_transit: "正在核验最终相邻交通段并重排时间", compile_result: "正在编译可信度与最终结果",
};

function cookieValue(request: Request, name: string): string {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

export function taskSessionCookie(value: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const base = `${SESSION_COOKIE}=${encodeURIComponent(value)}; Max-Age=86400; Path=/`;
  if (url.protocol === "https:") return `${base}; Secure; HttpOnly; SameSite=Strict`;
  if (url.protocol === "http:" && isLoopback) return `${base}; HttpOnly; SameSite=Strict`;
  throw new Error("规划任务会话仅支持 HTTPS；本机开发可使用 localhost 或 127.0.0.1");
}

async function taskSession(request: Request, env: any, create = false) {
  let value = cookieValue(request, SESSION_COOKIE);
  let setCookie = "";
  if (!value && create) {
    value = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    setCookie = taskSessionCookie(value, request.url);
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
  const memoSkipped = stage === "planner_memo" && profile?.deepReasoning === false;
  return {
    phase: stage === "parse_profile" ? "analysis" : stage.startsWith("variant_") || stage.startsWith("audit_") || stage.startsWith("repair_") || stage === "critic_review" || stage === "final_transit" || stage === "compile_result" ? "route" : "live",
    title: memoSkipped ? "已关闭深度思考，本阶段将跳过" : stageLabels[stage] || "正在规划",
    items: [`✓ 已完成 ${Math.max(0, completed)}/${WORKFLOW_STAGES.length} 个持久阶段`, ...(memoSkipped ? ["● 联网取证和硬约束校验不会跳过"] : []), ...extra, `● 当前检查点：${stage}`],
    sources: sources.map((attempt, index) => ({ id: /天气/.test(attempt.capability) ? "weather" : /景点/.test(attempt.capability) ? "spots" : /住宿|酒店/.test(attempt.capability) ? "hotels" : /交通|矩阵/.test(attempt.capability) ? "routing" : /拥挤/.test(attempt.capability) ? "crowd" : /时令|趋势/.test(attempt.capability) ? "season" : `${attempt.capability}-${index}`, label: attempt.capability, provider: attempt.provider, state: attempt.status === "success" ? "success" : attempt.status === "failed" || attempt.status === "rate_limited" ? "error" : "unavailable", detail: [attempt.code, attempt.detail, attempt.resultCount == null ? "" : `${attempt.resultCount} 条`].filter(Boolean).join(" · ") })),
    formSync: profile, generatedAt: new Date().toISOString(), collapsible: true,
  };
}

async function updateWorkflowRuntime(jobId: string, patch: Record<string, unknown>) {
  const previous: any = await getTravelJobArtifact(jobId, "runtime:v30");
  const now = Date.now();
  const next = {
    ...previous,
    version: 30,
    mode: patch.mode || previous?.mode || "running",
    currentStage: cleanText(patch.currentStage || previous?.currentStage || "queued"),
    currentMicroStep: cleanText(patch.currentMicroStep || previous?.currentMicroStep || "queued"),
    microStepStartedAt: Number(patch.microStepStartedAt || previous?.microStepStartedAt || now),
    lastHeartbeatAt: Number(patch.lastHeartbeatAt || now),
    attempt: Number(patch.attempt ?? previous?.attempt ?? 1),
    ...patch,
  };
  await putTravelJobArtifact(jobId, "runtime:v30", next);
  return next;
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
  const microStepStartedAt = Date.now();
  const researchState = stage === "planner_research" ? await getTravelJobArtifact<PlannerResearchState>(jobId, "research:state:v30") : null;
  await updateWorkflowRuntime(jobId, {
    mode: "running", currentStage: stage,
    currentMicroStep: stage === "planner_research" ? currentResearchMicroStep(researchState) : stage,
    microStepStartedAt, lastHeartbeatAt: microStepStartedAt,
    retryNotBefore: undefined, attempt: Number(job.attemptCount || 0) + 1,
    provider: undefined, model: undefined, providerCallStartedAt: undefined,
    providerCallDurationMs: undefined, providerOutcome: undefined, degradedReason: undefined,
  });
  await updateTravelJob(jobId, { status: "working", workflowId: owner, currentStep: stage, heartbeatAt: Date.now(), progress: await progressForStage(jobId, stage, await getTravelJobArtifact(jobId, "envelope") || job.payload) });
  await addTravelJobEvent({ jobId, eventType: "stage_started", step: stage, message: stageLabels[stage] || stage, createdAt: Date.now() });
  let leaseRenewalFailed = false;
  const heartbeat = setInterval(() => {
    renewTravelJobLease(jobId, owner, nonce).then(async (renewed) => {
      if (!renewed) leaseRenewalFailed = true;
      else await updateWorkflowRuntime(jobId, { lastHeartbeatAt: Date.now() });
    }).catch(() => { leaseRenewalFailed = true; });
  }, 15_000);
  const assertCommitAllowed = async () => {
    if (leaseRenewalFailed) throw new Error("LEASE_LOST");
    const current = await getTravelJob(jobId);
    if (!current || current.status === "cancelled" || current.cancelRequestedAt) throw new Error("TASK_CANCELLED");
    if (current.leaseOwner !== owner || current.leaseNonce !== nonce || Number(current.leaseExpiresAt || 0) < Date.now()) throw new Error("LEASE_LOST");
  };
  env = {
    ...env,
    AI_ASSERT_ACTIVE: assertCommitAllowed,
    ADVANCE_EXECUTION_BUDGET: createAdvanceExecutionBudget(microStepStartedAt, ADVANCE_SOFT_BUDGET_MS),
    AI_RUNTIME_UPDATE: (patch: Record<string, unknown>) => updateWorkflowRuntime(jobId, { ...patch, lastHeartbeatAt: Date.now() }),
    AI_RECORD_MODEL_ATTEMPT: async (attempt: any) => {
      await updateWorkflowRuntime(jobId, { ...attempt, lastHeartbeatAt: Date.now() });
      await recordJobProviderAttempt(jobId, stage, {
        provider: `${attempt.provider}：${attempt.model}`,
        capability: `模型调用 / ${attempt.purpose}`,
        status: attempt.providerOutcome === "success" ? "success" : attempt.providerOutcome === "rate_limited" ? "rate_limited" : "failed",
        code: attempt.providerOutcome === "timeout" ? "TIMEOUT" : attempt.providerOutcome === "rate_limited" ? "RATE_LIMITED" : undefined,
        detail: attempt.error || attempt.providerOutcome,
        latencyMs: attempt.providerCallDurationMs,
        resultCount: attempt.providerOutcome === "success" ? 1 : 0,
      });
    },
  };
  try {
    let envelope: any = await getTravelJobArtifact(jobId, "envelope");
    if (stage === "parse_profile") {
      const input = job.payload;
      const profile = await extractProfile(input, env);
      const modelProvider = aiProviderLabel(aiEndpoint(env));
      if (profile.extractionFallbackReason) await recordJobProviderAttempt(jobId, stage, { provider: `${modelProvider} V4 Flash`, capability: "需求理解", status: /429|频繁|额度/.test(profile.extractionFallbackReason) ? "rate_limited" : "degraded", detail: `${profile.extractionFallbackReason}；已使用文本规则与明确参数继续`, resultCount: 1 });
      else await recordJobProviderAttempt(jobId, stage, { provider: profile.extractionModel ? `${modelProvider}：${profile.extractionModel}` : `${modelProvider} V4 Flash`, capability: "需求理解", status: "success", detail: profile.extractionReuseReason || "正式用户画像已生成", resultCount: 1 });
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
          { provider: "Open-Meteo", capability: "天气", ok: prepared.providerBundle.weather.status === "ready", count: prepared.weather?.tripForecast?.length || 0, detail: prepared.providerBundle.weather.status === "ready" ? "Open-Meteo 已返回未来 16 天天气及日照时间" : prepared.providerBundle.weather.error },
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
    if (stage === "planner_research") {
      const prepared: any = await getTravelJobArtifact(jobId, "prepared");
      if (!prepared?.knowledge) throw new Error("规划知识包检查点缺失");
      const researchAdvance = await advanceResearchAgentCheckpoint(jobId, envelope.profile, prepared.knowledge, env);
      await assertCommitAllowed();
      await updateWorkflowRuntime(jobId, {
        mode: "running", currentStage: stage,
        currentMicroStep: currentResearchMicroStep(researchAdvance.state),
        lastHeartbeatAt: Date.now(),
      });
      if (!researchAdvance.done) {
        const progress = await progressForStage(jobId, stage, envelope, [
          `✓ 已持久化微检查点：${researchAdvance.operationId}${researchAdvance.reused ? "（幂等复用）" : ""}`,
          `● 下一工作单元：${currentResearchMicroStep(researchAdvance.state)}`,
        ]);
        await updateTravelJob(jobId, { status: "working", currentStep: stage, heartbeatAt: Date.now(), progress });
        await addTravelJobEvent({ jobId, eventType: "micro_step_completed", step: stage, message: researchAdvance.operationId, detail: { next: currentResearchMicroStep(researchAdvance.state), reused: researchAdvance.reused }, createdAt: Date.now() });
        return { ok: true, stage, microStep: researchAdvance.operationId, nextMicroStep: currentResearchMicroStep(researchAdvance.state), partial: true, done: false };
      }
      const research: any = researchAdvance.report;
      const plannerState: any = await getTravelJobArtifact(jobId, "planner_state") || newWorkflowPlannerState(envelope.profile, env);
      plannerState.research = research;
      plannerState.modelAudit.researchModel = research.model;
      plannerState.verifiedWebContext = list(research.searchExecutions).map((execution: any) => ({
        tool: "search_orchestrator", query: execution.request?.query, questionType: execution.request?.questionType,
        reason: execution.request?.reason, expectedDecisionImpact: execution.request?.expectedDecisionImpact,
        providers: execution.providersAttempted, providerFailures: execution.providerFailures,
        resultCount: execution.results?.length || 0, fetchedAt: execution.executedAt,
      }));
      plannerState.modelAudit.toolCalls = plannerState.verifiedWebContext;
      if (research.modelStatus !== "ready") {
        plannerState.modelAudit.degraded = true;
        plannerState.modelAudit.planningMode = "ai_assisted";
        plannerState.modelAudit.degradationReason = [plannerState.modelAudit.degradationReason, "Research Agent 模型不可用，已使用确定性缺口规划与多源检索继续取证"].filter(Boolean).join("；");
        plannerState.modelAudit.compilerIssues.push({ code: "RESEARCH_MODEL_DEGRADED", severity: "warning", message: research.modelError || "Research Agent 未返回可用查询计划" });
      }
      await putTravelJobArtifact(jobId, "planner_state", plannerState);
      await Promise.all([
        putTravelJobArtifact(jobId, "research:gap-map", research.gaps),
        putTravelJobArtifact(jobId, "research:queries", research.searchExecutions),
        putTravelJobArtifact(jobId, "research:evidence", research.evidence),
        putTravelJobArtifact(jobId, "research:fact-store", research.facts),
        putTravelJobArtifact(jobId, "research:metrics", research.metrics),
        putTravelJobArtifact(jobId, "research:skipped", research.skipped),
      ]);
      await recordJobProviderAttempt(jobId, stage, {
        provider: `Search Orchestrator + ${research.model || "确定性研究规划器"}`,
        capability: "AI Research / 多源证据",
        status: research.status === "ready" ? "success" : research.status === "unavailable" ? "failed" : "degraded",
        detail: `${research.searchExecutions?.length || 0} 次搜索 · ${research.evidence?.length || 0} 条独立证据 · ${research.facts?.length || 0} 个事实；停止原因 ${research.budget?.stopReason || "unknown"}`,
        resultCount: research.facts?.length || 0,
      });
    }
    if (stage === "planner_memo" || stage === "critic_review" || stage.startsWith("variant_") || stage.startsWith("audit_") || stage.startsWith("repair_")) {
      const prepared: any = await getTravelJobArtifact(jobId, "prepared");
      if (!prepared?.knowledge) throw new Error("规划知识包检查点缺失");
      const plannerState = await runPlannerWorkflowStage(stage, envelope.profile, prepared.knowledge, env, envelope.replanContext, await getTravelJobArtifact(jobId, "planner_state"), await getTravelJobArtifact(jobId, `attempt:${stage}`));
      await assertCommitAllowed();
      await putTravelJobArtifact(jobId, "planner_state", plannerState);
      if (stage === "critic_review") await putTravelJobArtifact(jobId, "critic:review", { status: plannerState.modelAudit.criticStatus, model: plannerState.modelAudit.criticModel, issues: plannerState.modelAudit.criticIssues });
      if (stage.startsWith("variant_")) await putTravelJobArtifact(jobId, stage, plannerState.draft.variants.find((variant: any) => variant.id === stage.slice(8)));
    }
    if (stage === "final_transit") {
      const prepared: any = await getTravelJobArtifact(jobId, "prepared");
      const plannerState: any = await getTravelJobArtifact(jobId, "planner_state");
      if (!prepared || !plannerState?.audit || plannerState.audit.hardIssues?.length) throw new Error("最终审计检查点未通过");
      const researchPrepared = applyResearchToPrepared(prepared, plannerState.research);
      const result = await buildPlan(envelope.profile, envelope.city, env, envelope.replanContext, async (progress) => updateTravelJob(jobId, { status: "working", currentStep: stage, heartbeatAt: Date.now(), progress }), researchPrepared, { draft: plannerState.draft, audit: plannerState.audit, modelAudit: plannerState.modelAudit, research: plannerState.research });
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
    if (/TASK_CANCELLED/.test(message)) return { status: "cancelled", currentStep: stage, retryable: false };
    if (/租约暂不可用|LEASE_LOST/.test(message)) return { status: "working", retryable: true, retryAfterMs: 10_000, currentStep: stage };
    if (isDurableAiWait(error) || isAdvanceBudgetExhausted(error)) {
      const retryAfterMs = isDurableAiWait(error) ? error.retryAfterMs : error.retryAfterMs;
      const retryNotBefore = Date.now() + Math.max(500, retryAfterMs);
      const runtime: any = await getTravelJobArtifact(jobId, "runtime:v30");
      await updateWorkflowRuntime(jobId, {
        mode: "waiting", currentStage: stage, currentMicroStep: runtime?.currentMicroStep || stage,
        retryNotBefore, lastHeartbeatAt: Date.now(),
        degradedReason: isDurableAiWait(error) ? "正在等待模型调用窗口" : "当前工作单元已用完安全执行预算",
      });
      if (stage === "planner_research") {
        const researchState: any = await getTravelJobArtifact(jobId, "research:state:v30");
        if (researchState) {
          const key = currentResearchMicroStep(researchState);
          researchState.retryNotBefore = retryNotBefore;
          researchState.retryCounters[key] = Number(researchState.retryCounters[key] || 0) + 1;
          await putTravelJobArtifact(jobId, "research:state:v30", researchState);
        }
      }
      const envelope = await getTravelJobArtifact(jobId, "envelope") || job.payload;
      const progress = await progressForStage(jobId, stage, envelope, [isDurableAiWait(error) ? "● 正在等待模型调用窗口；不会在 Worker 请求中长时间休眠" : "● 当前工作单元已安全结束，将从检查点继续"]);
      await updateTravelJob(jobId, { progress, heartbeatAt: Date.now() });
      return { status: "working", executionState: "waiting", currentStep: stage, retryable: true, retryAfterMs: Math.max(500, retryAfterMs), retryNotBefore, progress };
    }
    if (isAiRateLimited(error)) {
      const previous: any = await getTravelJobArtifact(jobId, `rate-limit:${stage}`);
      const attempts = Number(previous?.attempts || 0) + 1;
      await putTravelJobArtifact(jobId, `rate-limit:${stage}`, { attempts, lastError: message });
      if (attempts >= 3) {
        await updateTravelJob(jobId, { status: "error", errorCode: "AI_RATE_LIMITED", errorMessage: "模型持续限流，多次等待后仍不可用。检查点已保留，请确认服务商配额后重试。", completedAt: Date.now() });
        return { status: "error", currentStep: stage, retryable: false };
      }
      const envelope = await getTravelJobArtifact(jobId, "envelope") || job.payload;
      const progress = await progressForStage(jobId, stage, envelope, ["! 模型请求限流，正在等待配额恢复；这不是方案结构错误"]);
      await updateTravelJob(jobId, { progress, heartbeatAt: Date.now() });
      const retryAfterMs = AI_RATE_LIMIT_COOLDOWN_MS + 5000;
      const retryNotBefore = Date.now() + retryAfterMs;
      await updateWorkflowRuntime(jobId, { mode: "waiting", currentStage: stage, retryNotBefore, lastHeartbeatAt: Date.now(), providerOutcome: "rate_limited", degradedReason: "模型服务限流" });
      return { status: "working", executionState: "waiting", currentStep: stage, retryable: true, retryAfterMs, retryNotBefore, progress };
    }
    const attemptKey = `attempt:${stage}`;
    const previous: any = await getTravelJobArtifact(jobId, attemptKey);
    const attempts = Number(previous?.attempts || 0) + 1;
    const deterministicFailure = /时间轴不可执行|最终审计检查点未通过|规划模型经两轮修复后仍有|确定性编译器拒绝|所有阶段已结束|检查点缺失/.test(message);
    const limit = deterministicFailure ? 1 : stage.startsWith("variant_") || stage.startsWith("repair_") || stage === "planner_memo" ? 2 : 3;
    if (stage === "parse_profile" || stage === "planner_memo" || stage.startsWith("variant_") || stage.startsWith("repair_")) {
      const modelProvider = aiProviderLabel(aiEndpoint(env));
      await recordJobProviderAttempt(jobId, stage, { provider: stage === "parse_profile" ? `${modelProvider}需求理解模型` : `${modelProvider}规划模型`, capability: stage === "parse_profile" ? "需求理解" : stage.startsWith("repair_") ? "约束修复" : "行程决策", status: /429|频繁|额度/.test(message) ? "rate_limited" : "failed", detail: message, resultCount: 0 });
    }
    await putTravelJobArtifact(jobId, attemptKey, { attempts, lastError: message, updatedAt: new Date().toISOString() });
    if (attempts >= limit) {
      await updateTravelJob(jobId, { status: "error", currentStep: stage, attemptCount: Number(job.attemptCount || 0) + 1, errorCode: deterministicFailure ? "STAGE_VALIDATION_FAILED" : "STAGE_RETRY_EXHAUSTED", errorMessage: deterministicFailure ? `${stageLabels[stage] || stage}未通过：${message}` : `${stageLabels[stage] || stage}连续失败 ${attempts} 次：${message}`, completedAt: Date.now() });
      await addTravelJobEvent({ jobId, eventType: "stage_failed", step: stage, message: `${stageLabels[stage] || stage}重试耗尽`, detail: { attempts, error: message }, createdAt: Date.now() });
      return { status: "error", currentStep: stage, retryable: false };
    }
    const envelope = await getTravelJobArtifact(jobId, "envelope") || job.payload;
    const progress = await progressForStage(jobId, stage, envelope, [`! 本阶段第 ${attempts} 次调用失败，将从检查点自动重试`, `! ${message}`]);
    await updateTravelJob(jobId, { status: "working", currentStep: stage, heartbeatAt: Date.now(), attemptCount: Number(job.attemptCount || 0) + 1, progress });
    await addTravelJobEvent({ jobId, eventType: "stage_retry", step: stage, message: `${stageLabels[stage] || stage}将在检查点重试`, detail: { attempts, limit, error: message }, createdAt: Date.now() });
    return { status: "working", currentStep: stage, retryable: true, retryAfterMs: /429|频繁|额度/.test(message) ? AI_RATE_LIMIT_COOLDOWN_MS + 5_000 : Math.min(60_000, attempts * 10_000), progress };
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
      const purposeModels = {
        extractionModel: aiPrimaryModel(env, "extract"),
        researchModel: aiPrimaryModel(env, "research"),
        enrichmentModel: aiPrimaryModel(env, "enrich"),
        plannerModel: aiPrimaryModel(env, "planner"),
        criticModel: aiPrimaryModel(env, "critic"),
        repairModel: aiPrimaryModel(env, "repair"),
      };
      const plannerCandidates = aiModelCandidates(env, "planner");
      const providerName = aiProviderLabel(aiEndpoint(env));
      const servicePrefix = providerName === "联通元景" ? "联通元景 AI" : providerName;
      const serviceForModel = (model: string) => services.find((service: any) => service.provider === `${servicePrefix}：${model}`);
      const primaryService: any = serviceForModel(purposeModels.plannerModel);
      const validatedModel = plannerCandidates.find((model) => Number(serviceForModel(model)?.successCount || 0) > 0) || null;
      const aiStatus = !aiApiKey(env)
        ? "unconfigured"
        : primaryService?.status === "healthy"
          ? "ready"
          : validatedModel
            ? "degraded"
          : primaryService?.status === "degraded"
            ? "degraded"
            : primaryService?.status === "unavailable"
              ? "unavailable"
              : "configured_unverified";
      return json({
      ok: true,
      ai: {
        status: aiStatus,
        configured: Boolean(aiApiKey(env)),
        provider: providerName,
        model: purposeModels.plannerModel,
        ...purposeModels,
        plannerCandidates,
        validatedModel,
        fallbackActive: Boolean(validatedModel && validatedModel !== purposeModels.plannerModel),
        validation: primaryService ? { status: primaryService.status, lastSuccessAt: primaryService.lastSuccessAt, lastFailureAt: primaryService.lastFailureAt, lastErrorCode: primaryService.lastErrorCode, lastErrorMessage: primaryService.lastErrorMessage } : { status: "unknown", lastSuccessAt: null, lastFailureAt: null, lastErrorCode: null, lastErrorMessage: null },
        repairFallbackModel: aiModelCandidates(env, "repair")[1] || null,
        thinking: { planner: "user-controlled", repair: "on-conflict", reasoningContentExposed: false },
        network: { enabled: true, mode: "后端受控 Research Agent", tools: ["多 Provider 搜索编排", "不可信网页读取与访问状态", "证据过滤/去重/冲突合成", "Wikimedia / 高德 POI", "天气、酒店与交通专用数据源"] },
        note: validatedModel
          ? primaryService?.status === "healthy"
            ? `最近真实请求已验证 ${validatedModel} 可用；各阶段按候选顺序自动兼容路由。算法负责预算、缓存、证据等级、客流推断、交通矩阵、硬约束和降级恢复。`
            : `${validatedModel} 已有真实成功调用，但最近一次请求失败，当前按 degraded 展示并保留具体错误；不会把“曾成功”冒充“当前完全正常”。`
          : "密钥和模型名已配置，但尚无该规划模型的成功调用记录；configured 不再等同于 ready。",
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
      // A task whose browser disappeared for several minutes must not block a
      // deliberate new submission forever. Its durable artifacts remain in D1.
      await expireStaleTravelJobs(session.hash);
      const existingActive = await findActiveTravelJob(session.hash, true);
      if (existingActive) return json({ error: { message: "您已有一个规划任务正在执行，可重新连接或先取消", code: "CONCURRENT_JOB_LIMIT", jobId: existingActive.id } }, 409, { "set-cookie": session.setCookie, "cache-control": "no-store" });
      const input = await request.json().catch(() => ({}));
      const requestedDays = Number(deterministicProfileHints(input?.freeText).days ?? input?.days);
      if (Number.isFinite(requestedDays) && (requestedDays < 1 || requestedDays > 7)) {
        return json({ error: { message: "当前单次规划支持 1—7 天，请调整行程天数后重试", code: "UNSUPPORTED_TRIP_DURATION" } }, 400, { "set-cookie": session.setCookie, "cache-control": "no-store" });
      }
      const idempotencyKey = cleanText(request.headers.get("x-idempotency-key"));
      if (idempotencyKey.length < 16) return json({ error: { message: "缺少幂等请求标识，请刷新页面后重试", code: "IDEMPOTENCY_KEY_REQUIRED" } }, 400, { "set-cookie": session.setCookie });
      const globalJobs = await activeJobCount();
      if (globalJobs >= 4) return json({ error: { message: "当前规划队列繁忙，请稍后再试", code: "GLOBAL_CONCURRENCY_LIMIT" } }, 503, { "retry-after": "20" });
      const dailyQuota = await consumeRateLimit("global", "plan-daily", clamp(env?.DAILY_PLAN_QUOTA || 100, 20, 1000), 24 * 60 * 60 * 1000);
      if (!dailyQuota.allowed) return json({ error: { message: "今日公开规划额度已用完，请明日再试", code: "DAILY_QUOTA_EXCEEDED" } }, 429, { "retry-after": String(dailyQuota.retryAfterSeconds) });
      const jobId = crypto.randomUUID();
      const progress = { phase: "queued", title: "规划任务已建立断点", items: ["● 正在启动第一阶段", "● 刷新或断网不会丢失进度；重新打开后自动续跑", "● 完全关闭页面时任务暂停，不会继续消耗模型额度"], generatedAt: new Date().toISOString() };
      const now = Date.now();
      const created = await createTravelJob({
        id: jobId, idempotencyKey, clientHash, accessTokenHash: "", status: "queued", payload: input,
        progress, result: null, errorMessage: null, createdAt: now, updatedAt: now, expiresAt: now + 24 * 60 * 60 * 1000,
        workflowId: null, engineVersion: "v30-durable-micro-checkpoint", currentStep: "queued", heartbeatAt: now, leaseOwner: null, leaseNonce: null, leaseExpiresAt: null, cancelRequestedAt: null, attemptCount: 0, errorCode: null, completedAt: null, sessionHash: session.hash,
      });
      if (created.created) {
        await updateTravelJob(jobId, { status: "queued", workflowId: "sites-checkpoint-runner", currentStep: "queued", heartbeatAt: Date.now() });
        await addTravelJobEvent({ jobId, eventType: "job_queued", step: "queued", message: "站内断点执行器已就绪；刷新或断网后可从最后检查点续跑", detail: { runner: "durable-micro-checkpoint-v30" }, createdAt: Date.now() });
      }
      return json({ jobId: created.job.id, status: "queued", progress: created.job.progress || progress, engineVersion: "v30-durable-micro-checkpoint" }, 202, { "set-cookie": session.setCookie, "cache-control": "no-store" });
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

    if (url.pathname === "/api/plan/retry" && request.method === "POST") {
      const session = await taskSession(request, env);
      if (!session.hash) return json({ error: { message: "任务会话已失效", code: "JOB_SESSION_REQUIRED" } }, 401);
      const body = await request.json().catch(() => ({}));
      const requestedId = cleanText(body.jobId);
      const job = requestedId ? await getTravelJob(requestedId) : await findLatestTravelJob(session.hash);
      if (!job || job.sessionHash !== session.hash) return json({ error: { message: "没有可恢复的规划任务", code: "RETRY_JOB_NOT_FOUND" } }, 404);
      if (job.status !== "error" || Date.now() > job.expiresAt) return json({ error: { message: "该任务当前不能从检查点继续", code: "RETRY_NOT_ALLOWED" } }, 409);
      const stage = await nextIncompleteStage(job.id);
      if (!stage) return json({ error: { message: "任务缺少可恢复的检查点", code: "RETRY_CHECKPOINT_MISSING" } }, 409);
      const reset = await resetTravelJobForRetry(job.id, session.hash, stage);
      if (!reset) return json({ error: { message: "任务状态已变化，请重新连接", code: "RETRY_STATE_CHANGED" } }, 409);
      const envelope: any = await getTravelJobArtifact(job.id, "envelope");
      const progress = await progressForStage(job.id, stage, envelope || { profile: job.payload, city: { name: cleanText((job.payload as any)?.city) } }, ["● 已保留前面全部成功检查点", `● 正在从 ${stageLabels[stage] || stage} 继续`]);
      await updateTravelJob(job.id, { status: "working", currentStep: stage, heartbeatAt: Date.now(), progress, errorMessage: null, errorCode: null, completedAt: null });
      await addTravelJobEvent({ jobId: job.id, eventType: "job_resumed", step: stage, message: `已从失败检查点恢复：${stageLabels[stage] || stage}`, createdAt: Date.now() });
      return json({ jobId: job.id, status: "working", progress, input: job.payload, resumedFrom: stage }, 202, { "cache-control": "no-store" });
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
      const [events, providerAttempts, rawRuntime] = await Promise.all([listTravelJobEvents(id), listJobProviderAttempts(id), getTravelJobArtifact(id, "runtime:v30")]);
      const execution = runtimeStateForClient(rawRuntime as any, Date.now(), job.leaseExpiresAt);
      const common = {
        jobId: id, status: job.status, progress: job.progress, currentStep: job.currentStep,
        heartbeatAt: job.heartbeatAt ? new Date(job.heartbeatAt).toISOString() : null,
        execution, retryNotBefore: execution?.retryNotBefore || null,
        retryAfterMs: execution?.retryNotBefore ? Math.max(0, execution.retryNotBefore - Date.now()) : 0,
        events, providerAttempts, engineVersion: job.engineVersion,
      };
      if (job.status === "done" && job.result) return json({ ...common, result: job.result }, 200, { "cache-control": "no-store" });
      if (job.status === "error") return json({ ...common, error: { message: job.errorMessage || "规划任务执行失败", code: job.errorCode } }, 200, { "cache-control": "no-store" });
      if (job.status === "cancelled") return json({ ...common, error: { message: "规划任务已取消", code: "USER_CANCELLED" } }, 200, { "cache-control": "no-store" });
      return json(common, 200, { "cache-control": "no-store", "retry-after": "2" });
    }

    if (url.pathname === "/api/plan/active" && request.method === "GET") {
      const session = await taskSession(request, env);
      if (!session.hash) return json({ active: false }, 200, { "cache-control": "no-store" });
      const job = await findActiveTravelJob(session.hash);
      const runtime = job ? runtimeStateForClient(await getTravelJobArtifact(job.id, "runtime:v30") as any, Date.now(), job.leaseExpiresAt) : null;
      return json(job ? { active: true, jobId: job.id, status: job.status, progress: job.progress, currentStep: job.currentStep, execution: runtime, retryNotBefore: runtime?.retryNotBefore || null, heartbeatAt: job.heartbeatAt ? new Date(job.heartbeatAt).toISOString() : null, createdAt: new Date(job.createdAt).toISOString() } : { active: false }, 200, { "cache-control": "no-store" });
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
    { id: "weather", label: "天气预报", provider: providerBundle.weather.status === "ready" ? "Open-Meteo（未来 16 天）" : "未返回", state: providerBundle.weather.status === "ready" ? "success" : "error", detail: providerBundle.weather.error },
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
    const availabilityWindows = parseAvailabilityWindows({
      openingHours: spot.openingHours,
      dates: weather.tripForecast.map((day: any) => day.date),
      sourceId: `source-${spot.id}-opening`,
      verified: spot.openingStatus?.status === "verified",
    });
    return {
      id: spot.id, name: canonicalName, officialName: spot.officialName || spot.name, aliases: imageLookupNames(canonicalName, city.name), lat: Number(spot.lat), lng: Number(spot.lng),
      category: spot.category, poiType: spot.category || "旅游景点", cluster: cleanText(spot.district || spot.address, "Unknown"),
      plannerScore: Number(spot.plannerScore || 0),
      scoreBreakdown: { ...spot.scoreBreakdown },
      scoreConfidence: {
        ...spot.scoreBreakdown?.confidence,
        overall: Number((Object.values(spot.scoreBreakdown?.confidence || {}).reduce((sum: number, value: any) => sum + Number(value || 0), 0) / Math.max(1, Object.keys(spot.scoreBreakdown?.confidence || {}).length)).toFixed(2)),
      },
      scoreBasis: spot.scoreBasis,
      preferenceContributions: spot.preferenceContributions,
      matchedPreferences: spot.matchedPreferences,
      recommendationReasons: spot.recommendationReasons,
      recommendedDurationMin: clamp(spot.durationMin || 120, 60, 240),
      duration: { min: clamp((spot.durationMin || 120) * 0.65, 40, 180), expected: clamp(spot.durationMin || 120, 60, 240), max: clamp((spot.durationMin || 120) * 1.45, 90, 300) },
      openingHours: spot.openingHours || null,
      availabilityWindows,
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
      tags, experienceTags: tags.map((tag) => tag.toLowerCase()), requiredByUser: Boolean(spot.requiredByUser), sourceName: spot.sourceName || spot.source || "公开地图 / 中文维基百科",
      chosenEntrance: { status: "fallback_centroid", lat: Number(spot.lat), lng: Number(spot.lng), source: "POI 中心点；尚未取得可核验入口坐标" },
      entryExitBufferMin: /景区|乐园|故宫|山|湿地|古镇|动物园|海洋馆/.test(`${canonicalName}${spot.category || ""}`) ? 20 : 6,
      constraints: {
        mustVisit: Boolean(spot.requiredByUser),
        excluded: false,
        earliest: availabilityWindows[0]?.start,
        latest: availabilityWindows[0]?.end,
      },
      uncertainty: {
        openingHours: spot.openingStatus?.status === "verified" ? 0.1 : spot.openingHours ? 0.38 : 1,
        price: spot.ticketPrice != null ? 0.35 : 1,
        crowd: 1 - Math.min(1, Number(spot.crowd?.confidence || 0)),
        transit: 0.45,
      },
      sourceUrl: spot.sourceUrl || null, fetchedAt: spot.fetchedAt || fetchedAt,
      sources: [{ name: spot.sourceName || spot.source || "公开地图 / 中文维基百科", url: spot.sourceUrl || null, fetchedAt: spot.fetchedAt || fetchedAt, status: spot.openingHours ? "entity-verified" : "entity-only" }],
      unknown: [!spot.openingHours ? "开放时间" : null, (spot.requiredByUser || /博物馆|美术馆|纪念馆|故宫|寺|塔|乐园|动物园|海洋馆|演出|展览/.test(`${canonicalName}${spot.category || ""}`)) ? "指定日期预约" : null, "官方实时客流"].filter(Boolean),
    };
  });
  const knowledge = {
    profile: { ...profile, freeText: undefined, extractionModel: undefined }, city,
    constraintModel: compileConstraintModel(profile),
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
  if (Array.isArray(hotel.candidates) && hotel.candidates.length) {
    const anchors = plannerSpots.filter((spot: any) => spot.requiredByUser).concat(plannerSpots.filter((spot: any) => !spot.requiredByUser).slice(0, 8)).slice(0, 12);
    hotel.candidates = hotel.candidates.map((candidate: any) => {
      const [candidateLng, candidateLat] = cleanText(candidate.location).split(",").map(Number);
      const lat = Number(candidate.lat || candidateLat);
      const lng = Number(candidate.lng || candidateLng);
      const averageAnchorDistanceKm = Number.isFinite(lat) && Number.isFinite(lng) && anchors.length
        ? anchors.reduce((sum: number, spot: any) => sum + haversine(lat, lng, Number(spot.lat), Number(spot.lng)) / 1000, 0) / anchors.length
        : null;
      const pricePenalty = Number(candidate.price || 0) / 120;
      const locationUtility = averageAnchorDistanceKm == null ? 50 : clamp(100 - averageAnchorDistanceKm * 8, 0, 100);
      const hotelUtility = Number((locationUtility * 0.65 + Number(candidate.rating || 4) * 7 - pricePenalty).toFixed(1));
      return { ...candidate, averageAnchorDistanceKm: averageAnchorDistanceKm == null ? null : Number(averageAnchorDistanceKm.toFixed(2)), hotelUtility, hotelUtilityBasis: "候选 POI 距离启发式 65% + 地图评分 - 参考价惩罚；非实时交通或成交价" };
    }).sort((left: any, right: any) => Number(right.hotelUtility || 0) - Number(left.hotelUtility || 0));
    hotel.recommendedCandidateId = hotel.candidates[0]?.id || null;
  }
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
  await report?.(liveProgress(profile, city, "公共交通矩阵已建立，规划模型正在生成三套方案……", [
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
  const finalCoverageRepair = enforceRequiredCoverage(generated.draft, knowledge);
  if (finalCoverageRepair.changes.length) {
    bindTrafficMatrixFacts(generated.draft, knowledge);
    legalizePlannerTimelines(generated.draft, knowledge);
    const safetyRepair = applyFinalTimelineSafetyRepair(generated.draft, knowledge);
    bindTrafficMatrixFacts(generated.draft, knowledge);
    generated.audit = auditPlannerDraft(generated.draft, knowledge);
    generated.modelAudit.compilerIssues.push({
      code: "FINAL_REQUIRED_COVERAGE_ENFORCED", severity: "warning",
      message: `最终编译阶段补回 ${finalCoverageRepair.replaced} 个必选绑定${finalCoverageRepair.rebuilt ? `，重建 ${finalCoverageRepair.rebuilt} 套方案` : ""}；随后重排 ${safetyRepair.reflowedActivities} 个节点`,
      changes: finalCoverageRepair.changes,
    });
    if (generated.audit.hardIssues.length) {
      const summary = generated.audit.hardIssues.slice(0, 8).map((issue: any) => `${cleanText(issue.code)}：${cleanText(issue.message)}`).join("；");
      throw new Error(`必选项补全后的最终编译仍存在硬冲突：${summary}`);
    }
  }
  const research = generated.research || knowledge.research || null;
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
    if (!draftVariant || draftVariant.days.length !== profile.days) throw new Error(`规划模型返回的${variantId}方案天数不完整，已拒绝算法补齐`);
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
    const budgetBreakdown = estimateTripCost({
      profile,
      plan: { id: variantId, city: city.name, daysPlan, hotelPlan: hotel },
      research: research ? { facts: research.facts, evidence: research.evidence } : null,
    });
    alternatives.push({
      id: variantId, city: city.name, cityRef: city, startDate: profile.startDate, days: profile.days, budget: profile.budget,
      style: draftVariant?.style || profile.style, preferences: profile.preferences, pace: profile.pace, variant: variantId, transport: profile.transport,
      title: draftVariant?.title || ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex], strategy: draftVariant?.strategy || "依据候选景点知识包与交通矩阵", weather,
      daysPlan, hotelPlan: hotel,
      budgetBreakdown,
      budgetWarning: ["tight", "over_budget", "unknown"].includes(budgetBreakdown.budgetStatus) ? `${budgetBreakdown.budgetStatusLabel}：${budgetBreakdown.note}` : null,
      dataSources: { weather: weather.source || "Unavailable", spots: "中文维基百科 / OSM / 高德 POI", hotels: hotel.candidates?.length ? "高德酒店 POI / 酒店 MCP" : "Unknown", routing: trafficMatrix.source, transit: "高德地图 MCP；不可用时保留 OSRM 矩阵事实", costs: "Trip Cost V2：酒店 Provider、门票研究证据、实际 itinerary legs、实际饭点与金额加权不确定性规则", images: "高德官方 / Wikimedia / Unsplash", crowd: "Crowd Risk v2：日期/时段、景点承载特征、天气、公开趋势（非实时人数）", hotness: intelligence.news.status === "ready" ? intelligence.news.provider : "Unknown", seasonality: "近期公开报道中的时令实况信号；无证据则 Unknown", social: intelligence.social.status === "ready" ? intelligence.social.provider : "可选社交 MCP 未连接", reservations: "Unknown" },
      generatedAt: fetchedAt,
      planningDecision: { mode: generated.modelAudit.planningMode, researchModel: generated.modelAudit.researchModel, model: generated.modelAudit.plannerModel, criticModel: generated.modelAudit.criticModel, criticStatus: generated.modelAudit.criticStatus, criticIssues: generated.modelAudit.criticIssues, repairModel: generated.modelAudit.repairModel, repairRounds: generated.modelAudit.repairRounds, formatRepairs: generated.modelAudit.formatRepairs, networkToolCalls: generated.modelAudit.toolCalls, degraded: generated.modelAudit.degraded, degradationReason: generated.modelAudit.degradationReason || null, draftCompilerIssues: generated.modelAudit.compilerIssues },
      changeScope: replanContext && variantId === replanContext.activeVariant ? { mode: affectedDayIndexes.length ? "minimum-disruption" : "global-with-preservation-guidance", affectedDays: affectedDayIndexes.map((index: number) => index + 1), preservedDays: Array.from({ length: profile.days }, (_, index) => index + 1).filter((day) => !affectedDayIndexes.includes(day - 1)), note: "未受影响日期的稳定景点 ID 与原时间由后端锁定，不交给模型重写。" } : null,
    });
  }

  for (const plan of alternatives) {
    plan.contractVersion = "3.0";
    plan.plannerVersion = "deterministic-optimizer-v3";
    plan.scoringVersion = "candidate-score-v3-confidence";
    plan.crowdModelVersion = "crowd-risk-v2";
    plan.costModelVersion = "trip-cost-v2";
    plan.evaluation = planEvaluation(plan, profile, spots.length);
    plan.optimization = { algorithm: `${modelFamily(generated.modelAudit.plannerModel)} ${generated.modelAudit.deepReasoningUsed ? "深度决策" : "快速决策"} + Research Agent + 多目标路线优化 + Travel Compiler`, candidateCount: spots.length, selectedCount: plan.evaluation.evidence.selectedCount, requiredCoverage: `${plan.evaluation.evidence.requiredMatched.length}/${plan.evaluation.evidence.requiredTotal}`, note: generated.modelAudit.planningMode === "deterministic_recovery" ? "规划模型未返回可编译结构；系统已明确降级为确定性多目标路线优化，并继续执行开放时间、交通、用餐和必去约束校验。" : `Research Agent 先按信息增益取证；交通矩阵在模型调用前生成；实际模型 ${cleanText(generated.modelAudit.plannerModel, "unknown")} ${generated.modelAudit.deepReasoningUsed ? "形成决策备忘录后" : "在用户关闭深度思考时直接"}生成三套草案，独立 Critic 与确定性编译器再检查硬冲突。` };
    plan.candidatePool = spots.map((spot: any) => ({ id: spot.id, name: spot.name, category: spot.category, score: spot.plannerScore, scoreBreakdown: spot.scoreBreakdown, scoreBasis: spot.scoreBasis, requiredByUser: spot.requiredByUser, matchedPreferences: spot.matchedPreferences, selected: plan.daysPlan.some((day: any) => day.items.some((item: any) => item.id === spot.id)) }));
    Object.assign(plan, analyzePlanTrustV2(plan, profile));
    plan.reproducibility = reproducibilitySnapshot({
      request: { ...profile, freeText: undefined },
      candidates: plan.candidatePool,
      facts: plan.travelFacts,
      providers: plan.dataSources,
      model: generated.modelAudit.plannerModel,
      createdAt: fetchedAt,
    });
    if (plan.robustnessSimulation?.seed != null) plan.reproducibility.randomSeed = plan.robustnessSimulation.seed;
    if (profile.budget && ["tight", "over_budget"].includes(plan.budgetBreakdown?.budgetStatus)) {
      plan.compiler?.issues?.push({
        code: plan.budgetBreakdown.budgetStatus === "over_budget" ? "BUDGET_OVER" : "BUDGET_TIGHT",
        severity: plan.budgetBreakdown.budgetStatus === "over_budget" ? "warning" : "info",
        message: `${plan.budgetBreakdown.budgetStatusLabel}；必去景点未删除，请优先复核住宿、收费景点和交通方式`,
      });
    }
    plan.decisionTrace = buildResearchDecisionTrace(plan, research);
    plan.decisionTraceCoverage = traceCoverage(plan.decisionTrace);
    plan.changeSet = null;
    if (replanContext && plan.id === replanContext.activeVariant) {
      const previousDaysPlan = replanContext.days.map((previousDay: any) => ({ day: Number(previousDay.day), date: addDays(profile.startDate, Number(previousDay.day) - 1), items: previousDay.items || [], blocks: [] }));
      plan.changeSet = computeChangeSet({ ...plan, daysPlan: previousDaysPlan, changeSet: null }, plan, affectedDayIndexes.map((index: number) => index + 1));
    }
  }

  const diversityProfiles = buildPlanDiversityProfiles(alternatives);
  for (const plan of alternatives) plan.diversity = diversityProfiles[plan.id];

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
    `${generated.modelAudit.planningMode === "deterministic_recovery" ? "●" : "✓"} 规划模式：${generated.modelAudit.planningMode === "ai_optimized" ? `${generated.modelAudit.plannerModel} AI 优化` : generated.modelAudit.planningMode === "ai_assisted" ? "AI 辅助 + 确定性校验" : "确定性多目标恢复"}；研究查询 ${research?.metrics?.searchCount || 0} 次`,
    `✓ Research 指标：独立证据 ${research?.metrics?.independentEvidenceCount || 0} 条，去重率 ${Math.round(Number(research?.metrics?.evidenceDedupRatio || 0) * 100)}%，时效覆盖 ${Math.round(Number(research?.metrics?.freshnessCoverage || 0) * 100)}%，决策影响覆盖 ${Math.round(Number(research?.metrics?.decisionImpactCoverage || 0) * 100)}%`,
    `${generated.modelAudit.criticStatus === "ready" ? "✓" : "●"} 独立 Critic：${generated.modelAudit.criticStatus === "ready" ? `${generated.modelAudit.criticIssues?.length || 0} 条审查意见` : "AI Critic 不可用，已由确定性审计接管"}`,
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
      { id: "research", label: "联网研究与证据合成", provider: research ? `Search Orchestrator / ${research.model || "确定性研究规划器"}` : "未运行", state: research?.status === "ready" ? "success" : research?.status === "degraded" ? "unavailable" : "error", detail: research ? `${research.metrics?.searchCount || 0} 次搜索 · ${research.metrics?.independentEvidenceCount || 0} 条独立证据 · ${research.facts?.length || 0} 个事实` : "没有研究报告" },
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
  const alternativeComparison = alternatives.map((plan: any) => ({ id: plan.id, title: plan.title, reliability: plan.compiler?.reliability, fragility: plan.fragility?.score, informationCompleteness: plan.compiler?.informationCompleteness, minBufferMinutes: plan.compiler?.minBufferMinutes, selectedCount: plan.evaluation?.evidence?.selectedCount, transportMinutes: plan.evaluation?.evidence?.transportMinutes, unknownCount: plan.uncertainty?.count, verificationCount: plan.minimumVerification?.length, stressResilientCount: plan.stressTest?.resilientCount, researchToDecisionTraceCoverage: plan.decisionTraceCoverage?.coverage }));
  const activeId = replanContext?.activeVariant || "relax";
  const activePlan = alternatives.find((plan: any) => plan.id === activeId) || alternatives[0];
  const workspaceId = `travel-${cleanText(city.name).replace(/\s+/g, "-")}-${profile.startDate}`;
  const result = {
    request: profile, alternatives, alternativeComparison, activeId, generatedAt: fetchedAt,
    research: research ? { status: research.status, model: research.model, modelStatus: research.modelStatus, budget: research.budget, metrics: research.metrics, facts: research.facts, skipped: research.skipped, sourceTierDistribution: research.metrics?.sourceTierDistribution, dataPolicy: research.dataPolicy, fetchedAt: research.fetchedAt } : { status: "not-run" },
    agentEvents: buildPlanningEvents(workspaceId, profile, activePlan),
    planner: {
      type: "deepseek-dual-model-constraint-solver",
      provider: aiProviderLabel(aiEndpoint(env)),
      extractionModel: profile.extractionModel || aiPrimaryModel(env, "extract"),
      researchModel: generated.modelAudit.researchModel,
      plannerModel: generated.modelAudit.plannerModel,
      criticModel: generated.modelAudit.criticModel,
      repairModel: generated.modelAudit.repairModel,
      repairFallbackModel: aiModelCandidates(env, "repair")[1] || null,
        thinking: { planner: generated.modelAudit.deepReasoningUsed ? "enabled" : "disabled-by-user", repair: "on-conflict", hiddenReasoningExposed: false },
      network: {
        enabled: true,
        implementation: "Search Orchestrator 按问题类型选择官方站点、地图、普通网页与 UGC；页面访问状态、证据等级、冲突与时效单独记录；天气、酒店、交通由后端专用 Provider 先行取证",
        actualToolCalls: generated.modelAudit.toolCalls,
      },
      trafficMatrix: { readyBeforePlanner: true, source: trafficMatrix.source, legCount: trafficMatrix.legs.length, verifiedLegCount: candidateVerifiedLegs, estimatedLegCount: candidateEstimatedLegs, coveragePercent: candidateCoverage, finalVerifiedLegCount: amapVerifiedLegs, finalLegCount: uniqueTransitLegs.length, finalCoveragePercent: finalTransitCoverage, fetchedAt: trafficMatrix.fetchedAt },
      repairRounds: generated.modelAudit.repairRounds,
      planningMode: generated.modelAudit.planningMode,
      degraded: generated.modelAudit.degraded,
      tokenBudget: {
        planner: modelTokenBudget("planner"),
        research: modelTokenBudget("research"),
        repair: modelTokenBudget("repair"),
        compactKnowledgeApproxTokens: approximateTokens(compactPlannerKnowledge(knowledge)),
      },
      workflow: { type: "dependency-dag", nodes: PLANNING_WORKFLOW_DAG, executionGroups: workflowExecutionGroups(), uiMilestones: WORKFLOW_STAGES },
      stages: [
        `${profile.extractionModel || aiPrimaryModel(env, "extract")} 需求结构化`,
        `${generated.modelAudit.researchModel} 自适应 Research Agent 与多源证据合成`,
        "规划前交通矩阵",
        `${generated.modelAudit.plannerModel} 三方案时间轴`,
        `${generated.modelAudit.criticModel} 独立审查`,
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
