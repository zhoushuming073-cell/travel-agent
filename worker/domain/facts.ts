import type {
  EvidenceQuality,
  FactObservation,
  FactSource,
  ImportanceLevel,
  ItineraryPlan,
  TravelFact,
  TravelFactStatus,
  TravelProfile,
} from "./types.ts";

export const FACT_TTL_MS = {
  weather: 12 * 60 * 60 * 1000,
  route: 30 * 60 * 1000,
  transit: 30 * 60 * 1000,
  crowd: 15 * 60 * 1000,
  reservation: 15 * 60 * 1000,
  hotelPrice: 60 * 60 * 1000,
  openingOfficial: 24 * 60 * 60 * 1000,
  openingPublic: 7 * 24 * 60 * 60 * 1000,
  hotness: 6 * 60 * 60 * 1000,
  seasonality: 24 * 60 * 60 * 1000,
} as const;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function iso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function confidenceFor(status: TravelFactStatus): number {
  if (status === "verified") return 0.9;
  if (status === "estimated") return 0.68;
  if (status === "predicted") return 0.55;
  if (status === "stale") return 0.35;
  if (status === "conflicting") return 0.25;
  return 0;
}

export function isStale(updatedAt: string, ttlMs: number, now = Date.now()): boolean {
  const timestamp = Date.parse(updatedAt);
  return !Number.isFinite(timestamp) || now - timestamp > ttlMs;
}

export function resolveObservationStatus(
  observations: FactObservation[],
  fallbackStatus: TravelFactStatus,
  ttlMs: number,
  now = Date.now(),
): TravelFactStatus {
  const usable = observations.filter((item) => item.value !== null && item.value !== undefined && item.value !== "");
  if (!usable.length) return fallbackStatus === "unknown" ? "unknown" : fallbackStatus;
  if (new Set(usable.map((item) => stableValue(item.value))).size > 1) return "conflicting";
  const newest = Math.max(...usable.map((item) => Date.parse(item.source.fetchedAt)).filter(Number.isFinite));
  if (!Number.isFinite(newest) || now - newest > ttlMs) return "stale";
  if (usable.some((item) => item.source.quality === "verified")) return "verified";
  if (usable.some((item) => item.source.quality === "predicted")) return "predicted";
  return fallbackStatus;
}

function source(
  id: string,
  name: string,
  type: string,
  url: string | null,
  fetchedAt: string,
  quality: EvidenceQuality,
): FactSource {
  return { id, name, type, url, fetchedAt, quality };
}

function importance(subject: string, field: string, required = false): ImportanceLevel {
  if (/预约|开放/.test(field)) return required ? "high" : "medium";
  if (/天气|交通|酒店价格|拥挤|趋势热度|时令/.test(`${subject}${field}`)) return "medium";
  return "low";
}

function impact(subject: string, field: string, required = false): string {
  if (required && /开放|预约/.test(field)) return "可能导致必选节点无法执行，并把延误传导到同日后续节点";
  if (/天气/.test(`${subject}${field}`)) return "可能改变户外节点顺序、停留时长与室内替代方案";
  if (/交通/.test(`${subject}${field}`)) return "可能压缩后续景点、用餐与返程缓冲";
  if (/客流|拥挤/.test(field)) return "可能改变到访时段或触发同类型替代点";
  if (/趋势热度/.test(field)) return "只用于近期关注度排序，不能替代真实客流或预约状态";
  if (/时令/.test(field)) return "可能改变季节限定景观的优先级与同类型替代点";
  if (/酒店价格/.test(field)) return "可能改变住宿预算，但通常不直接改变日间路线";
  return "对当前路线影响有限";
}

interface FactInput {
  subject: string;
  field: string;
  value: unknown;
  status: TravelFactStatus;
  sourceType: string;
  sourceName: string;
  sourceUrl?: string | null;
  updatedAt: string;
  observedAt?: string | null;
  nature?: TravelFact["nature"];
  confidence?: number;
  importance: ImportanceLevel;
  uncertaintyReason?: string | null;
  downstreamImpact: string;
  observations?: FactObservation[];
  ttlMs: number;
}

function makeFact(index: number, input: FactInput, now: number): TravelFact {
  const status = input.observations?.length
    ? resolveObservationStatus(input.observations, input.status, input.ttlMs, now)
    : input.status !== "unknown" && isStale(input.updatedAt, input.ttlMs, now)
      ? "stale"
      : input.status;
  const fetchedAt = input.updatedAt;
  const nature = input.nature ?? (status === "predicted" ? "prediction" : status === "estimated" ? "public-reference" : status === "unknown" ? "unknown" : "observation");
  return {
    id: `fact-${index}`,
    subject: input.subject,
    field: input.field,
    value: input.value,
    status,
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    sourceUrl: input.sourceUrl ?? null,
    updatedAt: input.updatedAt,
    observedAt: input.observedAt ?? null,
    fetchedAt,
    expiresAt: new Date(Date.parse(fetchedAt) + input.ttlMs).toISOString(),
    nature,
    confidence: input.confidence ?? confidenceFor(status),
    importance: input.importance,
    uncertaintyReason: status === "conflicting"
      ? "多个来源对同一事实给出了不同值"
      : status === "stale"
        ? `数据超过 ${Math.round(input.ttlMs / 3_600_000)} 小时有效期，必须重新核验`
        : input.uncertaintyReason ?? null,
    downstreamImpact: input.downstreamImpact,
    observations: input.observations,
    ttlMs: input.ttlMs,
  };
}

export function buildTravelFacts(plan: ItineraryPlan, profile: TravelProfile, nowDate = new Date()): TravelFact[] {
  const now = nowDate.getTime();
  const generatedAt = iso(plan.generatedAt, nowDate.toISOString());
  const facts: TravelFact[] = [];
  const add = (input: FactInput): void => {
    facts.push(makeFact(facts.length + 1, input, now));
  };

  for (const day of plan.daysPlan) {
    const weatherReady = day.weather?.quality === "forecast";
    const weatherUpdatedAt = iso(day.weather?.fetchedAt ?? plan.weather?.fetchedAt, generatedAt);
    add({
      subject: `${day.date} 天气`,
      field: "逐日预报",
      value: weatherReady ? {
        weatherCode: day.weather?.weatherCode,
        temperatureMin: day.weather?.temperatureMin,
        temperatureMax: day.weather?.temperatureMax,
        precipitationProbability: day.weather?.precipitationProbability,
      } : null,
      status: weatherReady ? "predicted" : "unknown",
      nature: weatherReady ? "forecast" : "unknown",
      observedAt: weatherReady ? `${day.date}T12:00:00+08:00` : null,
      sourceType: weatherReady ? "weather-service" : "none",
      sourceName: weatherReady ? text(plan.weather?.source, "天气服务") : "预报范围外或服务未返回",
      updatedAt: weatherUpdatedAt,
      importance: "medium",
      uncertaintyReason: weatherReady ? "天气来源已成功返回，但数据性质仍是会随时间更新的预报，不是已发生事实" : text(day.weather?.note, "没有可用于该日期的预报"),
      downstreamImpact: impact("天气", "逐日预报"),
      ttlMs: FACT_TTL_MS.weather,
    });
    const sunset = text(day.weather?.sunset);
    if (sunset) {
      const match = sunset.match(/^(\d{1,2}):(\d{2})$/);
      const civilDuskMinute = match ? Number(match[1]) * 60 + Number(match[2]) + 25 : null;
      add({
        subject: `${day.date} 太阳时段`,
        field: "日落与民用暮光",
        value: {
          sunset,
          civilDusk: civilDuskMinute === null ? null : `${String(Math.floor(civilDuskMinute / 60)).padStart(2, "0")}:${String(civilDuskMinute % 60).padStart(2, "0")}`,
        },
        status: weatherReady ? "predicted" : "estimated",
        nature: weatherReady ? "forecast" : "public-reference",
        sourceType: weatherReady ? "weather-service" : "calculation",
        sourceName: weatherReady ? text(day.weather?.source, "天气服务") : "代码默认日落估算",
        updatedAt: weatherUpdatedAt,
        importance: "medium",
        uncertaintyReason: weatherReady ? "天文时刻来自天气服务，民用暮光为日落后 25 分钟的透明近似" : "缺少指定日期天文数据，使用已披露默认值",
        downstreamImpact: "决定夜景、灯光和日落体验的最早安排时段",
        ttlMs: FACT_TTL_MS.weather,
      });
    }

    const routeKnown = day.route?.quality === "routed" || day.route?.quality === "exact";
    const routeUpdatedAt = iso(day.route?.fetchedAt, generatedAt);
    add({
      subject: `Day ${day.day} 路线`,
      field: "道路路径与耗时",
      value: { distanceM: day.route?.distance ?? 0, durationSeconds: day.route?.duration ?? 0 },
      status: routeKnown ? "verified" : "estimated",
      sourceType: routeKnown ? "routing-service" : "calculation",
      sourceName: text(day.route?.source, "路线计算"),
      updatedAt: routeUpdatedAt,
      importance: "medium",
      uncertaintyReason: routeKnown ? null : "路线服务未返回可验证几何，采用已披露的坐标估算",
      downstreamImpact: impact("交通", "道路路径与耗时"),
      ttlMs: FACT_TTL_MS.route,
    });

    for (const spot of day.items) {
      const spotUpdatedAt = iso(spot.fetchedAt, generatedAt);
      const openingObservations = spot.factObservations?.openingHours ?? [];
      if (!openingObservations.length && spot.openingHours) {
        openingObservations.push({
          value: spot.openingHours,
          confidence: 0.68,
          source: source(
            `source-${spot.id}-opening`,
            text(spot.sourceName, "景点公开页面 / 地图标注"),
            "poi-public-data",
            spot.sourceUrl ?? null,
            spotUpdatedAt,
            "estimated",
          ),
        });
      }
      add({
        subject: spot.name,
        field: "开放时间",
        value: spot.openingHours ?? openingObservations[0]?.value ?? null,
        status: spot.openingHours || openingObservations.length ? "estimated" : "unknown",
        sourceType: openingObservations[0]?.source.type ?? "none",
        sourceName: openingObservations[0]?.source.name ?? "未取得景区官方当日公告",
        sourceUrl: openingObservations[0]?.source.url ?? spot.officialVerification?.officialSiteUrl ?? spot.officialVerification?.openingSearchUrl ?? spot.sourceUrl ?? null,
        updatedAt: openingObservations[0]?.source.fetchedAt ?? spotUpdatedAt,
        importance: importance(spot.name, "开放时间", spot.requiredByUser),
        uncertaintyReason: spot.openingHours ? "公开规则不等同于出行当日临时公告" : "公开数据未标注开放时间",
        downstreamImpact: impact(spot.name, "开放时间", spot.requiredByUser),
        observations: openingObservations,
        ttlMs: openingObservations.some((item) => item.source.type === "official") ? FACT_TTL_MS.openingOfficial : FACT_TTL_MS.openingPublic,
      });

      if (spot.openingStatus?.alert) {
        add({
          subject: spot.name,
          field: "开放状态提醒",
          value: spot.openingStatus.alert,
          status: "conflicting",
          sourceType: "official-publication-signal",
          sourceName: "近期官方来源相关公告",
          sourceUrl: spot.openingStatus.sourceUrl ?? spot.sourceUrl ?? null,
          updatedAt: iso(spot.openingStatus.updatedAt, spotUpdatedAt),
          confidence: 0.72,
          importance: importance(spot.name, "开放状态提醒", spot.requiredByUser),
          uncertaintyReason: "公告标题提示开放规则可能变化，需要打开原文核对生效日期与具体时段",
          downstreamImpact: impact(spot.name, "开放状态提醒", spot.requiredByUser),
          ttlMs: FACT_TTL_MS.openingOfficial,
        });
      }

      const reservationObservations = spot.factObservations?.reservation ?? [];
      if (spot.reservation?.relevant !== false) add({
        subject: spot.name,
        field: "预约状态",
        value: reservationObservations[0]?.value ?? null,
        status: reservationObservations.length ? "verified" : "unknown",
        sourceType: reservationObservations[0]?.source.type ?? "none",
        sourceName: reservationObservations[0]?.source.name ?? "景区官方预约接口未接入",
        sourceUrl: reservationObservations[0]?.source.url ?? spot.officialVerification?.reservationSearchUrl ?? spot.officialVerification?.officialSiteUrl ?? spot.website ?? spot.sourceUrl ?? null,
        updatedAt: reservationObservations[0]?.source.fetchedAt ?? spotUpdatedAt,
        importance: importance(spot.name, "预约状态", spot.requiredByUser),
        uncertaintyReason: reservationObservations.length ? null : "没有可验证的指定日期预约余量",
        downstreamImpact: impact(spot.name, "预约状态", spot.requiredByUser),
        observations: reservationObservations,
        ttlMs: FACT_TTL_MS.reservation,
      });

      const crowdObservations = spot.factObservations?.crowd ?? [];
      const crowdKnown = spot.crowd?.score !== undefined && spot.crowd?.score !== null;
      if (!crowdObservations.length && crowdKnown) {
        crowdObservations.push({
          value: { score: spot.crowd?.score, label: spot.crowd?.label, factors: spot.crowd?.factors, factorContributions: spot.crowd?.factorContributions, forecastBand: spot.crowd?.forecastBand, confidenceLabel: spot.crowd?.confidenceLabel, evidenceCoverage: spot.crowd?.evidenceCoverage, timeWindows: spot.crowd?.timeWindows, recommendedWindow: spot.crowd?.recommendedWindow, secondaryRecommendedWindow: spot.crowd?.secondaryRecommendedWindow, recommendedWindows: spot.crowd?.recommendedWindows, avoidWindow: spot.crowd?.avoidWindow, peakWindow: spot.crowd?.peakWindow, action: spot.crowd?.action, dataQualityNote: spot.crowd?.dataQualityNote, visitAdvice: spot.crowd?.visitAdvice, modelVersion: spot.crowd?.modelVersion, officialRealtime: false },
          confidence: spot.crowd?.confidence ?? 0.5,
          source: source(
            `source-${spot.id}-crowd`,
            text(spot.crowd?.source, "拥挤风险预测"),
            "prediction",
            null,
            iso(spot.crowd?.updatedAt, spotUpdatedAt),
            "predicted",
          ),
        });
      }
      add({
        subject: spot.name,
        field: "拥挤风险",
        value: crowdKnown ? { score: spot.crowd?.score, label: spot.crowd?.label, factors: spot.crowd?.factors, factorContributions: spot.crowd?.factorContributions, forecastBand: spot.crowd?.forecastBand, confidenceLabel: spot.crowd?.confidenceLabel, evidenceCoverage: spot.crowd?.evidenceCoverage, timeWindows: spot.crowd?.timeWindows, recommendedWindow: spot.crowd?.recommendedWindow, secondaryRecommendedWindow: spot.crowd?.secondaryRecommendedWindow, recommendedWindows: spot.crowd?.recommendedWindows, avoidWindow: spot.crowd?.avoidWindow, peakWindow: spot.crowd?.peakWindow, action: spot.crowd?.action, dataQualityNote: spot.crowd?.dataQualityNote, visitAdvice: spot.crowd?.visitAdvice, visitTime: spot.crowd?.visitTime, visitDate: spot.crowd?.visitDate, modelVersion: spot.crowd?.modelVersion, officialRealtime: false } : crowdObservations[0]?.value ?? null,
        status: crowdKnown || crowdObservations.length ? "predicted" : "unknown",
        sourceType: crowdObservations[0]?.source.type ?? "none",
        sourceName: crowdObservations[0]?.source.name ?? "无可验证官方客流来源",
        updatedAt: crowdObservations[0]?.source.fetchedAt ?? spotUpdatedAt,
        confidence: crowdObservations[0]?.confidence ?? (crowdKnown ? spot.crowd?.confidence : 0),
        importance: "medium",
        uncertaintyReason: crowdKnown || crowdObservations.length ? "预测不等于实时客流" : "未取得实时客流或可靠预测输入",
        downstreamImpact: impact(spot.name, "拥挤风险"),
        observations: crowdObservations,
        ttlMs: FACT_TTL_MS.crowd,
      });

      const hotnessObservations = spot.factObservations?.hotness ?? [];
      const hotnessKnown = spot.hotness?.score !== undefined && spot.hotness?.score !== null;
      if (hotnessKnown || hotnessObservations.length) add({
        subject: spot.name,
        field: "趋势热度",
        value: hotnessKnown ? { score: spot.hotness?.score, label: spot.hotness?.label } : hotnessObservations[0]?.value ?? null,
        status: hotnessKnown ? "predicted" : "unknown",
        sourceType: hotnessObservations[0]?.source.type ?? "none",
        sourceName: hotnessObservations[0]?.source.name ?? text(spot.hotness?.source, "近 7 天未取得可归因趋势信号"),
        sourceUrl: hotnessObservations[0]?.source.url ?? spot.hotness?.sourceUrl ?? null,
        updatedAt: hotnessObservations[0]?.source.fetchedAt ?? iso(spot.hotness?.updatedAt, spotUpdatedAt),
        confidence: hotnessObservations[0]?.confidence ?? spot.hotness?.confidence ?? 0,
        importance: importance(spot.name, "趋势热度"),
        uncertaintyReason: hotnessKnown ? "公开报道/授权社交信号只表示近期关注度，不等于景区在园人数" : "近 7 天没有取得可归因到该景点的趋势信号",
        downstreamImpact: impact(spot.name, "趋势热度"),
        observations: hotnessObservations,
        ttlMs: FACT_TTL_MS.hotness,
      });

      const seasonObservations = spot.factObservations?.seasonality ?? [];
      const seasonKnown = spot.seasonality?.score !== undefined && spot.seasonality?.score !== null;
      if (seasonKnown || seasonObservations.length) add({
        subject: spot.name,
        field: "时令适配",
        value: seasonKnown ? { score: spot.seasonality?.score, state: spot.seasonality?.state, label: spot.seasonality?.label } : seasonObservations[0]?.value ?? null,
        status: seasonKnown ? "predicted" : "unknown",
        sourceType: seasonObservations[0]?.source.type ?? "none",
        sourceName: seasonObservations[0]?.source.name ?? text(spot.seasonality?.source, "未取得指定日期时令实况证据"),
        sourceUrl: seasonObservations[0]?.source.url ?? spot.seasonality?.sourceUrl ?? null,
        updatedAt: seasonObservations[0]?.source.fetchedAt ?? iso(spot.seasonality?.updatedAt, spotUpdatedAt),
        confidence: seasonObservations[0]?.confidence ?? spot.seasonality?.confidence ?? 0,
        importance: importance(spot.name, "时令适配"),
        uncertaintyReason: seasonKnown ? "由近期公开报道提取的时令信号，仍需结合到访日天气复核" : "没有官方花期、秋色、冰雪或候鸟等指定日期实况证据",
        downstreamImpact: impact(spot.name, "时令适配"),
        observations: seasonObservations,
        ttlMs: FACT_TTL_MS.seasonality,
      });
    }

    for (const block of day.blocks.filter((item) => item.type === "leg")) {
      const hasMcp = Boolean(block.mcpTransport);
      add({
        subject: `${text(block.from)} → ${text(block.to)}`,
        field: "公共交通耗时",
        value: hasMcp ? block.mcpTransport?.durationMin : block.durationMin,
        status: hasMcp ? "estimated" : "unknown",
        sourceType: hasMcp ? "map-service" : "none",
        sourceName: hasMcp ? text(block.mcpTransport?.source, "高德地图 MCP") : "未取得公交 / 地铁方案",
        updatedAt: iso(block.mcpTransport?.fetchedAt, generatedAt),
        importance: "medium",
        uncertaintyReason: hasMcp ? "地图规划耗时不是实时班次承诺" : text(block.mcpStatus?.note, "仅有道路耗时参考"),
        downstreamImpact: impact("交通", "公共交通耗时"),
        ttlMs: FACT_TTL_MS.transit,
      });
    }
  }

  const pricedHotel = plan.hotelPlan?.candidates?.find((item) => typeof item.price === "number" && item.price > 0);
  const fallbackHotel = plan.hotelPlan?.candidates?.[0];
  if (pricedHotel || fallbackHotel) {
    const hotel = pricedHotel ?? fallbackHotel;
    add({
      subject: text(hotel?.name, "住宿候选"),
      field: "住宿参考价",
      value: pricedHotel?.price ?? null,
      status: pricedHotel ? "estimated" : "unknown",
      sourceType: pricedHotel ? "hotel-or-map-service" : "none",
      sourceName: text(pricedHotel?.source, "酒店 / 地图服务"),
      sourceUrl: pricedHotel?.sourceUrl ?? null,
      updatedAt: iso(pricedHotel?.fetchedAt, generatedAt),
      importance: "medium",
      uncertaintyReason: pricedHotel ? "只展示来源参考价，不纳入已知预算；指定日期房态、税费与成交价仍需下单复核" : "候选酒店未返回可追溯价格",
      downstreamImpact: "仅用于缩小住宿候选范围，不参与预算可行性判断",
      ttlMs: FACT_TTL_MS.hotelPrice,
    });
  }

  return facts;
}
