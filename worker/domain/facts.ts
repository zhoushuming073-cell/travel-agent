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
  if (required || /预约|开放/.test(field)) return "high";
  if (/天气|交通|酒店价格/.test(`${subject}${field}`)) return "medium";
  return "low";
}

function impact(subject: string, field: string, required = false): string {
  if (required && /开放|预约/.test(field)) return "可能导致必选节点无法执行，并把延误传导到同日后续节点";
  if (/天气/.test(`${subject}${field}`)) return "可能改变户外节点顺序、停留时长与室内替代方案";
  if (/交通/.test(`${subject}${field}`)) return "可能压缩后续景点、用餐与返程缓冲";
  if (/客流|拥挤/.test(field)) return "可能改变到访时段或触发同类型替代点";
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
      status: weatherReady ? "verified" : "unknown",
      sourceType: weatherReady ? "weather-service" : "none",
      sourceName: weatherReady ? text(plan.weather?.source, "天气服务") : "预报范围外或服务未返回",
      updatedAt: weatherUpdatedAt,
      importance: "medium",
      uncertaintyReason: weatherReady ? null : text(day.weather?.note, "没有可用于该日期的预报"),
      downstreamImpact: impact("天气", "逐日预报"),
      ttlMs: FACT_TTL_MS.weather,
    });

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
        sourceUrl: openingObservations[0]?.source.url ?? spot.sourceUrl ?? null,
        updatedAt: openingObservations[0]?.source.fetchedAt ?? spotUpdatedAt,
        importance: importance(spot.name, "开放时间", spot.requiredByUser),
        uncertaintyReason: spot.openingHours ? "公开规则不等同于出行当日临时公告" : "公开数据未标注开放时间",
        downstreamImpact: impact(spot.name, "开放时间", spot.requiredByUser),
        observations: openingObservations,
        ttlMs: openingObservations.some((item) => item.source.type === "official") ? FACT_TTL_MS.openingOfficial : FACT_TTL_MS.openingPublic,
      });

      const reservationObservations = spot.factObservations?.reservation ?? [];
      add({
        subject: spot.name,
        field: "预约状态",
        value: reservationObservations[0]?.value ?? null,
        status: reservationObservations.length ? "verified" : "unknown",
        sourceType: reservationObservations[0]?.source.type ?? "none",
        sourceName: reservationObservations[0]?.source.name ?? "景区官方预约接口未接入",
        sourceUrl: reservationObservations[0]?.source.url ?? spot.website ?? spot.sourceUrl ?? null,
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
          value: { score: spot.crowd?.score, label: spot.crowd?.label },
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
        value: crowdKnown ? { score: spot.crowd?.score, label: spot.crowd?.label } : crowdObservations[0]?.value ?? null,
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
      field: "酒店价格",
      value: pricedHotel?.price ?? null,
      status: pricedHotel ? "estimated" : "unknown",
      sourceType: pricedHotel ? "hotel-or-map-service" : "none",
      sourceName: text(pricedHotel?.source, "酒店 / 地图服务"),
      sourceUrl: pricedHotel?.sourceUrl ?? null,
      updatedAt: iso(pricedHotel?.fetchedAt, generatedAt),
      importance: "medium",
      uncertaintyReason: pricedHotel ? "为来源参考价，指定日期房态与成交价仍需下单复核" : "候选酒店未返回可追溯价格",
      downstreamImpact: impact("酒店", "酒店价格"),
      ttlMs: FACT_TTL_MS.hotelPrice,
    });
  }

  return facts;
}

