import type {
  BudgetStatus,
  CostNature,
  CostRange,
  DailyTripCost,
  ItineraryBlock,
  ItineraryDay,
  TravelProfile,
  TripCostCategory,
  TripCostEstimate,
  TripCostLine,
} from "./types.ts";

/**
 * Central planning assumptions. These are deliberately broad budgeting ranges,
 * never presented as provider observations or live prices. Provider-derived
 * prices always enter through hotel candidates or ticket research facts.
 */
export const TRIP_COST_RULES = {
  roomCapacityEstimate: 2,
  hotelReferenceMaxFactor: 1.3,
  publicTransitPerRide: {
    short: { min: 2, expected: 3, max: 5 },
    medium: { min: 3, expected: 5, max: 8 },
    long: { min: 5, expected: 8, max: 12 },
  },
  taxi: { baseDistanceKm: 3, baseMin: 10, baseExpected: 14, baseMax: 18, perKmMin: 2, perKmExpected: 2.7, perKmMax: 4 },
  meals: {
    economy: { breakfast: [8, 14, 20], lunch: [22, 38, 55], dinner: [30, 50, 75] },
    balanced: { breakfast: [12, 22, 35], lunch: [35, 60, 90], dinner: [50, 85, 130] },
    premium: { breakfast: [25, 45, 75], lunch: [70, 120, 190], dinner: [100, 180, 300] },
  },
  bufferRates: { verified: 0.03, referenced: 0.07, estimated: 0.15, unknownPenalty: 0.02, maximum: 0.28 },
} as const;

interface HotelCandidateInput {
  name?: string;
  price?: number | null;
  priceType?: string;
  source?: string;
  sourceUrl?: string | null;
  priceVerifiedForDates?: boolean;
}

interface CostPlanInput {
  id: string;
  city: string;
  daysPlan: ItineraryDay[];
  hotelPlan?: { note?: string; candidates?: HotelCandidateInput[] };
}

interface ResearchFactInput {
  targetId?: string;
  targetName?: string;
  factType?: string;
  questionType?: string;
  status?: string;
  value?: unknown;
  supportingEvidenceIds?: string[];
}

interface ResearchEvidenceInput {
  id?: string;
  title?: string;
  url?: string | null;
  publisher?: string;
  sourceTier?: string;
}

export interface TripCostInput {
  profile: TravelProfile;
  plan: CostPlanInput;
  research?: { facts?: ResearchFactInput[]; evidence?: ResearchEvidenceInput[] } | null;
}

const natureRank: Record<CostNature, number> = { verified: 0, referenced: 1, estimated: 2, unknown: 3 };
const categoryLabels: Record<TripCostCategory["id"], string> = {
  lodging: "住宿", tickets: "景点门票", meals: "餐饮", localTransport: "市内交通",
  intercityTransport: "城际交通", other: "其他可预见费用", buffer: "风险缓冲",
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function roundMoney(value: number): number {
  if (value === 0) return 0;
  return Math.max(10, Math.round(value / 10) * 10);
}

function roundSignedMoney(value: number): number {
  if (value === 0) return 0;
  return Math.round(value / 10) * 10;
}

function range(min: number, expected: number, max: number): CostRange {
  const normalized = [Math.max(0, min), Math.max(0, expected), Math.max(0, max)].sort((a, b) => a - b);
  return { min: roundMoney(normalized[0]), expected: roundMoney(normalized[1]), max: roundMoney(normalized[2]) };
}

function multiply(value: CostRange, factor: number): CostRange {
  return range(value.min * factor, value.expected * factor, value.max * factor);
}

function sumRanges(values: Array<CostRange | null | undefined>): CostRange | null {
  const present = values.filter((value): value is CostRange => Boolean(value));
  if (!present.length) return null;
  return range(
    present.reduce((sum, value) => sum + value.min, 0),
    present.reduce((sum, value) => sum + value.expected, 0),
    present.reduce((sum, value) => sum + value.max, 0),
  );
}

function line(input: Omit<TripCostLine, "amount"> & { amount?: CostRange | null }): TripCostLine {
  return { ...input, amount: input.amount ?? null };
}

function category(id: TripCostCategory["id"], lines: TripCostLine[]): TripCostCategory {
  const priced = lines.filter((item) => item.amount);
  const unknownCount = lines.filter((item) => item.nature === "unknown" || !item.amount).length;
  const nature = priced.length
    ? priced.reduce<CostNature>((worst, item) => natureRank[item.nature] > natureRank[worst] ? item.nature : worst, "verified")
    : "unknown";
  return { id, label: categoryLabels[id], nature, amount: sumRanges(priced.map((item) => item.amount)), lines, unknownCount };
}

function party(profile: TravelProfile) {
  const partySize = Math.max(1, Math.round(finite(profile.partySize) || 1));
  const explicitAdults = finite(profile.adults);
  const explicitChildren = finite(profile.children);
  const explicitSeniors = finite(profile.seniors);
  const hasComposition = explicitAdults !== null || explicitChildren !== null || explicitSeniors !== null;
  const adults = hasComposition ? Math.max(0, Math.round(explicitAdults || 0)) : partySize;
  const children = Math.max(0, Math.round(explicitChildren || 0));
  const seniors = Math.max(0, Math.round(explicitSeniors || 0));
  return { partySize: Math.max(partySize, adults + children + seniors), adults, children, seniors, hasComposition };
}

function lodgingLines(profile: TravelProfile, plan: CostPlanInput): { lines: TripCostLine[]; assumptions: string[] } {
  const nights = Math.max(0, Math.round(finite(profile.nights) ?? Math.max(0, Number(profile.days || plan.daysPlan.length) - 1)));
  if (!nights) return { lines: [line({ id: "lodging:none", label: "无需过夜", category: "lodging", nature: "verified", amount: range(0, 0, 0), basis: "行程为零晚住宿", sourceName: "行程日期" })], assumptions: [] };
  const group = party(profile);
  const roomCount = Math.max(1, Math.ceil(group.partySize / TRIP_COST_RULES.roomCapacityEstimate));
  const returnedPrice = (plan.hotelPlan?.candidates || []).find((item) => finite(item.price) !== null && Number(item.price) > 0);
  const priced = (plan.hotelPlan?.candidates || [])
    .filter((item) => finite(item.price) !== null && Number(item.price) > 0 && (item.priceVerifiedForDates || /每晚|每间/.test(item.priceType || "")))
    .sort((left, right) => Number(left.price) - Number(right.price))[0];
  const assumption = `暂按每间可住 ${TRIP_COST_RULES.roomCapacityEstimate} 人估算 ${roomCount} 间房；儿童是否同住、加床和税费需下单确认`;
  if (!priced) return {
    lines: [line({ id: "lodging:unknown", label: `${nights} 晚住宿`, category: "lodging", nature: "unknown", basis: `${returnedPrice ? "酒店 Provider 返回了参考金额，但未确认是每晚/每间，不能直接乘晚数" : "酒店 Provider 未返回可用价格"}；${assumption}`, sourceName: returnedPrice?.source || "住宿数据源未返回可计算价格", sourceUrl: returnedPrice?.sourceUrl })],
    assumptions: [assumption],
  };
  const nightly = Number(priced.price);
  const verified = Boolean(priced.priceVerifiedForDates);
  const perRoom = verified ? range(nightly, nightly, nightly) : range(nightly, nightly * 1.12, nightly * TRIP_COST_RULES.hotelReferenceMaxFactor);
  return {
    lines: [line({
      id: `lodging:${priced.name || "candidate"}`, label: `${priced.name || "住宿候选"} · ${nights} 晚 × ${roomCount} 间`, category: "lodging",
      nature: verified ? "verified" : "referenced", amount: multiply(perRoom, nights * roomCount),
      basis: `${priced.priceType || (verified ? "指定日期每晚每间价格" : "每晚每间参考价")}；${assumption}`,
      sourceName: priced.source || "酒店 Provider", sourceUrl: priced.sourceUrl,
    })], assumptions: [assumption],
  };
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); } catch { return String(value ?? ""); }
}

export function parseTicketCostValue(value: unknown) {
  if (value && typeof value === "object") {
    const row = value as { free?: unknown; includedInPass?: unknown; adultPrice?: unknown; childPrice?: unknown; seniorPrice?: unknown; note?: unknown };
    if (row.includedInPass === true) return { free: false, includedInPass: true, adultPrice: 0 };
    if (row.free === true) return { free: true, adultPrice: 0 };
    const adultPrice = finite(row.adultPrice);
    const childPrice = finite(row.childPrice);
    const seniorPrice = finite(row.seniorPrice);
    if (adultPrice !== null || childPrice !== null || seniorPrice !== null) return { free: false, adultPrice, childPrice, seniorPrice };
  }
  const text = textValue(value).replace(/[,，]/g, "");
  if (/免费开放|免费参观|免门票|门票免费|无需门票/.test(text) && !/部分|不含/.test(text)) return { free: true, adultPrice: 0 };
  const money = (regex: RegExp) => finite(text.match(regex)?.[1]);
  const adultPrice = money(/(?:成人(?:票|价)?|全价票)[^\d]{0,12}(\d+(?:\.\d+)?)\s*元?/) ?? money(/(?:门票|票价|价格)[^\d]{0,12}(\d+(?:\.\d+)?)\s*元/);
  const childPrice = money(/(?:儿童|学生)(?:票|价)?[^\d]{0,12}(\d+(?:\.\d+)?)\s*元?/);
  const seniorPrice = money(/(?:老人|老年|长者)(?:票|价)?[^\d]{0,12}(\d+(?:\.\d+)?)\s*元?/);
  if (adultPrice === null && childPrice === null && seniorPrice === null) return null;
  return { free: false, adultPrice, childPrice, seniorPrice };
}

function ticketLines(input: TripCostInput): TripCostLine[] {
  const group = party(input.profile);
  const facts = input.research?.facts || [];
  const evidence = new Map((input.research?.evidence || []).map((item) => [item.id, item]));
  const visited = new Map<string, { id: string; name: string; day: number }>();
  for (const day of input.plan.daysPlan) for (const spot of day.items || []) if (!visited.has(spot.id)) visited.set(spot.id, { id: spot.id, name: spot.name, day: day.day });
  return [...visited.values()].map((spot) => {
    const fact = facts.find((item) => item.targetId === spot.id && (item.factType === "ticket_policy" || item.questionType === "ticket_policy") && ["verified", "supported"].includes(String(item.status)));
    const parsed = fact ? parseTicketCostValue(fact.value) : null;
    const source = fact?.supportingEvidenceIds?.map((id) => evidence.get(id)).find(Boolean);
    if (!fact || !parsed) return line({ id: `ticket:${spot.id}`, label: spot.name, category: "tickets", nature: "unknown", basis: "当前研究证据未确认免费政策或适用票价，不生成假门票", sourceName: "门票证据不足", day: spot.day });
    const nature: CostNature = fact.status === "verified" ? "verified" : "referenced";
    if (parsed.free || parsed.includedInPass) return line({ id: `ticket:${spot.id}`, label: `${spot.name} · ${parsed.includedInPass ? "套票已含" : "免费"}`, category: "tickets", nature, amount: range(0, 0, 0), basis: parsed.includedInPass ? "当前证据明确此项目已包含在套票中，不重复计费" : "公开证据明确为免费开放；预约、特展或内部项目可能另计", sourceName: source?.publisher || source?.title || "门票公开证据", sourceUrl: source?.url, day: spot.day });
    const adult = parsed.adultPrice ?? 0;
    const knownAdultCost = adult * group.adults;
    const childKnown = parsed.childPrice !== null && parsed.childPrice !== undefined;
    const seniorKnown = parsed.seniorPrice !== null && parsed.seniorPrice !== undefined;
    const childExpected = childKnown ? Number(parsed.childPrice) * group.children : adult * group.children;
    const seniorExpected = seniorKnown ? Number(parsed.seniorPrice) * group.seniors : adult * group.seniors;
    const minimum = knownAdultCost + (childKnown ? childExpected : 0) + (seniorKnown ? seniorExpected : 0);
    const maximum = knownAdultCost + childExpected + seniorExpected;
    return line({
      id: `ticket:${spot.id}`, label: spot.name, category: "tickets", nature, amount: range(minimum, maximum, maximum),
      basis: `成人 ${group.adults} 人${group.children ? `、儿童 ${group.children} 人` : ""}${group.seniors ? `、老人 ${group.seniors} 人` : ""}；未查到的优惠资格不擅自打折，区间低值仅扣除未核实人群`,
      sourceName: source?.publisher || source?.title || "门票公开证据", sourceUrl: source?.url, day: spot.day,
    });
  });
}

function mealTier(profile: TravelProfile): keyof typeof TRIP_COST_RULES.meals {
  const text = `${profile.mealPreference || ""} ${profile.budgetLevel || ""} ${profile.hotelPreference || ""}`;
  if (/高端|品质|精致|奢华/.test(text)) return "premium";
  if (/经济|节省|预算优先|实惠/.test(text)) return "economy";
  return "balanced";
}

function mealLines(profile: TravelProfile, days: ItineraryDay[]) {
  const group = party(profile);
  const tier = mealTier(profile);
  const rules = TRIP_COST_RULES.meals[tier];
  const rows: TripCostLine[] = [];
  for (const day of days) {
    const mealBlocks = (day.blocks || []).filter((block) => block.type === "rest" && block.mealType);
    const types = mealBlocks.map((block) => String(block.mealType));
    const earliest = Math.min(...(day.blocks || []).map((block) => Number(String(block.startTime || "12:00").slice(0, 2)) || 12));
    const counts = { breakfast: types.filter((value) => value === "breakfast").length || (earliest < 11 ? 1 : 0), lunch: types.filter((value) => value === "lunch").length, dinner: types.filter((value) => value === "dinner").length };
    for (const mealType of ["breakfast", "lunch", "dinner"] as const) {
      const count = counts[mealType];
      if (!count) continue;
      const [min, expected, max] = rules[mealType];
      rows.push(line({
        id: `meal:${day.day}:${mealType}`, label: `${mealType === "breakfast" ? "早餐" : mealType === "lunch" ? "午餐" : "晚餐"} × ${count}`,
        category: "meals", nature: "estimated", amount: multiply(range(min, expected, max), group.partySize * count),
        basis: `${tier === "economy" ? "经济" : tier === "premium" ? "品质" : "适中"}餐饮档次 · ${group.partySize} 人；无真实菜单价格，按餐次而非固定每日金额估算`,
        sourceName: "实际行程饭点 + 餐饮预算规则 V1", day: day.day,
      }));
    }
  }
  return rows;
}

function isIntercity(block: ItineraryBlock) {
  return /高铁|动车|火车|城际|飞机|航班|长途客运/.test(`${block.mode || ""} ${block.label || ""} ${block.source || ""}`);
}

function publicRange(distanceKm: number): CostRange {
  const band = distanceKm <= 5 ? TRIP_COST_RULES.publicTransitPerRide.short : distanceKm <= 15 ? TRIP_COST_RULES.publicTransitPerRide.medium : TRIP_COST_RULES.publicTransitPerRide.long;
  return range(band.min, band.expected, band.max);
}

function taxiRange(distanceKm: number): CostRange {
  const rule = TRIP_COST_RULES.taxi;
  const chargedKm = Math.max(0, distanceKm - rule.baseDistanceKm);
  return range(rule.baseMin + chargedKm * rule.perKmMin, rule.baseExpected + chargedKm * rule.perKmExpected, rule.baseMax + chargedKm * rule.perKmMax);
}

function transportLines(profile: TravelProfile, days: ItineraryDay[]) {
  const group = party(profile);
  const local: TripCostLine[] = [];
  const intercity: TripCostLine[] = [];
  const seen = new Set<string>();
  for (const day of days) for (const block of day.blocks || []) {
    if (block.type !== "leg") continue;
    const key = `${day.day}|${block.from}|${block.to}|${block.startTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mode = String(block.mcpTransport?.source ? block.mcpTransport.source : block.mode || "公共交通 / 打车");
    const returnedFare = finite(block.fare ?? block.mcpTransport?.fare);
    const fare = returnedFare !== null && returnedFare > 0 ? returnedFare : null;
    if (isIntercity(block)) {
      intercity.push(line({
        id: `intercity:${key}`, label: `${block.from || "出发地"} → ${block.to || "目的地"}`, category: "intercityTransport",
        nature: fare !== null ? "referenced" : "unknown", amount: fare !== null ? multiply(range(fare, fare, fare), group.partySize) : null,
        basis: fare !== null ? `${group.partySize} 人，采用路段返回参考票价` : "检测到跨城交通，但未接入火车票/机票价格 Provider，不生成实时票价",
        sourceName: block.source || "城际交通路段", day: day.day,
      }));
      continue;
    }
    const distanceKm = Math.max(0, Number(block.distanceM || 0) / 1000);
    const walking = /步行|步道/.test(mode);
    const taxi = /出租|打车|网约|驾车/.test(mode) && !/公交|地铁/.test(mode);
    const transit = /公交|地铁/.test(mode) && !/打车|出租|网约/.test(mode);
    let amount: CostRange;
    let basis: string;
    let nature: CostNature = "estimated";
    if (fare !== null && !walking) {
      const sharedVehicle = taxi;
      const totalFare = fare * (sharedVehicle ? 1 : group.partySize);
      amount = range(totalFare, totalFare, totalFare);
      nature = /官方/.test(block.source || block.mcpTransport?.source || "") ? "verified" : "referenced";
      basis = `${profile.city}路段返回票价 ${fare} 元${sharedVehicle ? "，按一辆车共享" : ` × ${group.partySize} 人`}；使用 Provider 金额，不套用距离估算`;
    } else if (walking) {
      amount = range(0, 0, 0); basis = "规划路段为步行，不计交通票款";
    } else if (taxi) {
      amount = taxiRange(distanceKm); basis = `${distanceKm.toFixed(1)} km，按一辆车共享估算，不按 ${group.partySize} 人重复相乘；未接入实时计价`;
    } else if (transit) {
      amount = multiply(publicRange(distanceKm), group.partySize); basis = `${distanceKm.toFixed(1)} km 公交/地铁路段 × ${group.partySize} 人；未返回真实票价，按距离档位估算`;
    } else {
      const publicTotal = multiply(publicRange(distanceKm), group.partySize);
      const taxiTotal = taxiRange(distanceKm);
      amount = range(publicTotal.min, /公共交通/.test(profile.transport || "") ? publicTotal.expected : (publicTotal.expected + taxiTotal.expected) / 2, taxiTotal.max);
      basis = `${distanceKm.toFixed(1)} km 路段模式未完全锁定；低值按公共交通人数计费，高值按一辆出租车共享估算`;
    }
    local.push(line({ id: `local:${key}`, label: `${block.from || "上一站"} → ${block.to || "下一站"}`, category: "localTransport", nature, amount, basis, sourceName: block.source || "实际行程路段", day: day.day }));
  }
  if (!local.length) local.push(line({ id: "local:none", label: "未发现市内付费路段", category: "localTransport", nature: "estimated", amount: range(0, 0, 0), basis: "仅按当前 itinerary legs 计算，不使用每日固定交通费", sourceName: "实际行程路段" }));
  if (!intercity.length) intercity.push(line({ id: "intercity:none", label: "未发现跨城路段", category: "intercityTransport", nature: "verified", amount: range(0, 0, 0), basis: "当前方案为单城市行程；往返目的地的大交通不在计算范围", sourceName: "实际行程路段" }));
  return { local, intercity };
}

function bufferFor(categories: TripCostCategory[]) {
  const pricedLines = categories.flatMap((item) => item.lines).filter((item) => item.amount);
  const subtotal = sumRanges(categories.map((item) => item.amount));
  if (!subtotal) return { amount: null, reason: "没有可聚合金额，无法计算风险缓冲" };
  const bufferRateByNature: Record<CostNature, number> = {
    verified: TRIP_COST_RULES.bufferRates.verified,
    referenced: TRIP_COST_RULES.bufferRates.referenced,
    estimated: TRIP_COST_RULES.bufferRates.estimated,
    unknown: TRIP_COST_RULES.bufferRates.estimated,
  };
  const pricedWeight = pricedLines.reduce((sum, item) => sum + Math.max(1, Number(item.amount?.expected || 0)), 0);
  const weightedRate = pricedLines.length
    ? pricedLines.reduce((sum, item) => sum + bufferRateByNature[item.nature] * Math.max(1, Number(item.amount?.expected || 0)), 0) / Math.max(1, pricedWeight)
    : TRIP_COST_RULES.bufferRates.estimated;
  const unknownCount = categories.reduce((sum, item) => sum + item.unknownCount, 0);
  const rate = Math.min(TRIP_COST_RULES.bufferRates.maximum, weightedRate + unknownCount * TRIP_COST_RULES.bufferRates.unknownPenalty);
  return {
    amount: range(subtotal.min * Math.max(0.02, rate - 0.03), subtotal.expected * rate, subtotal.max * Math.min(TRIP_COST_RULES.bufferRates.maximum, rate + 0.04)),
    reason: `${pricedLines.filter((item) => item.nature === "verified").length} 项已核验、${pricedLines.filter((item) => item.nature === "referenced").length} 项参考价、${pricedLines.filter((item) => item.nature === "estimated").length} 项估算、${unknownCount} 项未知；按各项金额加权后采用约 ${Math.round(rate * 100)}% 的动态缓冲`,
  };
}

function budgetState(userBudget: number | null, total: CostRange | null, partial: boolean): { status: BudgetStatus; label: string; remaining: number | null } {
  if (!userBudget || !total) return { status: "unknown", label: "暂无法判断", remaining: null };
  const remaining = roundSignedMoney(userBudget - total.expected);
  if (total.min > userBudget) return { status: "over_budget", label: "预计超出预算", remaining };
  if (total.expected > userBudget || total.max > userBudget) return { status: "tight", label: partial ? "偏紧（仍有未知项）" : "偏紧", remaining };
  if (partial) return { status: "unknown", label: "部分费用未知", remaining: null };
  if (total.max <= userBudget * 0.82) return { status: "comfortable", label: "较充足", remaining };
  return { status: "reasonable", label: "基本合理", remaining };
}

function confidenceFor(categories: TripCostCategory[]) {
  const lines = categories.flatMap((item) => item.lines);
  const weights: Record<CostNature, number> = { verified: 1, referenced: 0.78, estimated: 0.48, unknown: 0 };
  const criticality: Record<TripCostCategory["id"], number> = { lodging: 1.5, tickets: 1.25, meals: 0.8, localTransport: 0.9, intercityTransport: 1.4, other: 0.45, buffer: 0.3 };
  const denominator = lines.reduce((sum, item) => sum + criticality[item.category] * Math.max(1, Number(item.amount?.expected || 0)), 0);
  const evidenceCoverage = denominator ? Math.round(lines.reduce((sum, item) => sum + weights[item.nature] * criticality[item.category] * Math.max(1, Number(item.amount?.expected || 0)), 0) / denominator * 100) : 0;
  const majorUnknown = categories.some((item) => ["lodging", "tickets", "intercityTransport"].includes(item.id) && item.unknownCount > 0);
  const confidence = Math.min(majorUnknown ? 0.58 : 0.9, evidenceCoverage / 100);
  return { evidenceCoverage, confidence, label: confidence >= 0.75 ? "较高" as const : confidence >= 0.5 ? "中等" as const : "较低" as const };
}

function dailyCosts(days: ItineraryDay[], categories: TripCostCategory[]): DailyTripCost[] {
  const dayLines = categories.flatMap((item) => item.lines).filter((item) => item.day && item.category !== "lodging" && item.category !== "buffer");
  return days.map((day) => ({
    day: day.day, date: day.date, amount: sumRanges(dayLines.filter((item) => item.day === day.day).map((item) => item.amount)),
    note: "住宿与总风险缓冲单独计算，未重复摊入每日费用",
  }));
}

export function estimateTripCost(input: TripCostInput): TripCostEstimate {
  const lodging = lodgingLines(input.profile, input.plan);
  const tickets = ticketLines(input);
  const meals = mealLines(input.profile, input.plan.daysPlan);
  const transport = transportLines(input.profile, input.plan.daysPlan);
  const baseCategories = [
    category("lodging", lodging.lines), category("tickets", tickets), category("meals", meals),
    category("localTransport", transport.local), category("intercityTransport", transport.intercity),
    category("other", [line({ id: "other:unidentified", label: "尚未识别可单独计价的其他费用", category: "other", nature: "unknown", amount: null, basis: "当前行程没有停车、接驳、寄存或服务费的可靠价格证据；不以 0 元冒充已完成估算，也不含购物、个人消费和纪念品", sourceName: "费用范围规则" })]),
  ];
  const subtotal = sumRanges(baseCategories.map((item) => item.amount));
  const buffer = bufferFor(baseCategories);
  const bufferCategory = category("buffer", [line({ id: "buffer:risk", label: "不确定性风险缓冲", category: "buffer", nature: "estimated", amount: buffer.amount, basis: buffer.reason, sourceName: "费用不确定性模型 V1" })]);
  const categories = [...baseCategories, bufferCategory];
  const total = sumRanges([subtotal, buffer.amount]);
  // An unidentified optional “other” item lowers evidence coverage but does
  // not by itself make every otherwise-complete trip partial. Known material
  // categories still control whether the displayed total is explicitly partial.
  const totalIsPartial = baseCategories.some((item) => item.id !== "other" && item.unknownCount > 0);
  const userBudget = finite(input.profile.budget);
  const state = budgetState(userBudget && userBudget > 0 ? userBudget : null, total, totalIsPartial);
  const confidence = confidenceFor(baseCategories);
  const note = totalIsPartial ? "预计区间仅汇总当前可计算项目；Unknown 项未被伪造为价格，最终实际支出可能更高。" : "预计区间由实际行程逐项聚合，仍需在购票与下单时复核。";
  return {
    version: "1.0", currency: "CNY", total, subtotal, totalIsPartial, bufferAmount: buffer.amount, bufferReason: buffer.reason,
    categories, daily: dailyCosts(input.plan.daysPlan, baseCategories), userBudget: userBudget && userBudget > 0 ? userBudget : null,
    budgetStatus: state.status, budgetStatusLabel: state.label, expectedRemaining: state.remaining,
    confidence: Number(confidence.confidence.toFixed(2)), confidenceLabel: confidence.label, evidenceCoverage: confidence.evidenceCoverage,
    scopeNote: "包含住宿、行程景点门票、行程内餐饮、市内交通、已识别城际路段、其他可预见费用与动态缓冲；默认不含出发地往返目的地的大交通。",
    exclusions: ["购物与纪念品", "个人消费", "未在行程中的娱乐消费", "未识别的出发地往返目的地大交通"],
    assumptions: lodging.assumptions,
    knownEstimate: total?.expected ?? null, limit: userBudget && userBudget > 0 ? userBudget : null,
    items: categories.map((item) => ({ name: item.label, amount: item.amount?.expected ?? null })), note,
  };
}
