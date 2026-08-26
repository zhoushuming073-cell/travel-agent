export type ProfileFieldSource = "text-rule" | "ai-text" | "parameter" | "calculated" | "default";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function explicit(value: unknown): string {
  const valueText = clean(value);
  return /^(unknown|未知|未设置|null|undefined)$/i.test(valueText) ? "" : valueText;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function clamp(value: unknown, min: number, max: number, fallback = min): number {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function currentChinaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function yearlessDate(month: number, day: number, todayIso: string): string | null {
  const [year, currentMonth, currentDay] = todayIso.split("-").map(Number);
  const targetYear = month < currentMonth || (month === currentMonth && day < currentDay) ? year + 1 : year;
  return isoDate(targetYear, month, day);
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

export function parseChineseInteger(value: unknown): number | null {
  const text = clean(value);
  if (/^\d{1,3}$/.test(text)) return Number(text);
  if (text in CN_DIGITS) return CN_DIGITS[text];
  if (text === "十") return 10;
  const ten = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (ten) return (ten[1] ? CN_DIGITS[ten[1]] : 1) * 10 + (ten[2] ? CN_DIGITS[ten[2]] : 0);
  return null;
}

function splitAttractions(value: string): string[] {
  return value
    .replace(/(?:这|这两|这几个)?(?:个)?(?:地方|景点)$/g, "")
    .split(/[、与及]|(?<!颐)和(?!平)/)
    .map((item) => item.replace(/^(?:去|游览|参观|吃|打卡)/, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 24 && !/^(?:旅游|旅行|游玩|玩)$/.test(item));
}

export interface DeterministicProfileHints extends Record<string, unknown> {
  fieldSources: Record<string, ProfileFieldSource>;
}

export function deterministicProfileHints(textValue: unknown, now = new Date()): DeterministicProfileHints {
  const text = clean(textValue);
  const result: DeterministicProfileHints = { fieldSources: {} };
  const source = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    result[field] = value;
    result.fieldSources[field] = "text-rule";
  };
  const today = currentChinaDate(now);

  const city = text.match(/(?:去|到|前往)\s*([\u4e00-\u9fa5]{2,8}?)(?=(?:市)?(?:旅游|旅行|游玩|出差|玩|待|住|，|,|。|；|;|\s|\d|[一二两三四五六七八九十]+天))|目的地(?:是|为)?\s*([\u4e00-\u9fa5]{2,8}?)(?:市|，|。|\s)/);
  if (city) source("city", clean(city[1] || city[2]).replace(/市$/, ""));

  const fullRange = text.match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?\s*(?:到|至|—|~|－|-)\s*(?:(20\d{2})[年./-])?(\d{1,2})[月./-](\d{1,2})日?/);
  const shortRange = !fullRange ? text.match(/(?:^|\D)(\d{1,2})[./-](\d{1,2})\s*(?:到|至|—|~|－|-)\s*(\d{1,2})[./-](\d{1,2})(?=\D|$)/) : null;
  if (fullRange) {
    const start = isoDate(Number(fullRange[1]), Number(fullRange[2]), Number(fullRange[3]));
    const end = isoDate(Number(fullRange[4] || fullRange[1]), Number(fullRange[5]), Number(fullRange[6]));
    if (start && end) {
      source("startDate", start);
      source("days", Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1));
    }
  } else if (shortRange) {
    const start = yearlessDate(Number(shortRange[1]), Number(shortRange[2]), today);
    if (start) {
      const startYear = Number(start.slice(0, 4));
      let end = isoDate(startYear, Number(shortRange[3]), Number(shortRange[4]));
      if (end && end < start) end = isoDate(startYear + 1, Number(shortRange[3]), Number(shortRange[4]));
      source("startDate", start);
      if (end) source("days", Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1));
    }
  } else {
    const fullDate = text.match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/);
    const shortDate = !fullDate ? text.match(/(?:^|[^\d])(\d{1,2})[./-](\d{1,2})(?:日)?(?=\s*(?:出发|启程|去|到|旅游|旅行|游玩|玩|，|,|。|$))/) : null;
    const chineseDate = !fullDate && !shortDate ? text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/) : null;
    if (fullDate) source("startDate", isoDate(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3])));
    else if (shortDate) source("startDate", yearlessDate(Number(shortDate[1]), Number(shortDate[2]), today));
    else if (chineseDate) source("startDate", chineseDate[1] ? isoDate(Number(chineseDate[1]), Number(chineseDate[2]), Number(chineseDate[3])) : yearlessDate(Number(chineseDate[2]), Number(chineseDate[3]), today));
    else if (/后天(?:出发|启程|去)/.test(text)) source("startDate", new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10).replace(/^.*$/, () => { const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 2); return date.toISOString().slice(0, 10); }));
    else if (/明天(?:出发|启程|去)/.test(text)) { const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); source("startDate", date.toISOString().slice(0, 10)); }
    else if (/今天(?:出发|启程|去)/.test(text)) source("startDate", today);
  }

  const duration = text.match(/(?:共|计划|玩|旅行|游玩|待)?\s*([\d一二两三四五六七八九十]{1,3})\s*天(?:\s*([\d一二两三四五六七八九十]{1,3})\s*晚)?/);
  if (duration) {
    const days = parseChineseInteger(duration[1]);
    const nights = parseChineseInteger(duration[2]);
    if (days) source("days", days);
    if (nights !== null) source("nights", nights);
  }

  const family = text.match(/一家([\d一二两三四五六七八九十])口/);
  const party = text.match(/([\d一二两俩三四五六七八九十]{1,3})\s*(?:个人|人)(?:出行|同行|旅行|游玩|去|玩)?/);
  const composition = text.match(/([\d一二两三四五六七八九十])\s*(?:大|成人).*?([\d一二两三四五六七八九十])\s*(?:小|儿童|孩子)/);
  if (composition) {
    const adults = parseChineseInteger(composition[1]) ?? 0;
    const children = parseChineseInteger(composition[2]) ?? 0;
    source("adults", adults); source("children", children); source("partySize", adults + children);
  } else if (family) source("partySize", parseChineseInteger(family[1]));
  else if (party) source("partySize", parseChineseInteger(party[1]));

  const required: string[] = [];
  for (const match of text.matchAll(/(?:一定|必须|必选|务必|明确|想|希望)(?:能|要)?去\s*([^，,。；;\n]+)/g)) required.push(...splitAttractions(match[1]));
  if (required.length) source("requiredAttractions", [...new Set(required)].filter((name) => name !== result.city));

  const start = text.match(/(?:上午|每天)?\s*(\d{1,2})\s*点(?:左右)?开始/);
  const end = text.match(/(?:晚上|每天)?\s*(\d{1,2})\s*点(?:前|之前)?结束/);
  if (start) source("dayStart", `${String(Number(start[1])).padStart(2, "0")}:00`);
  if (end) {
    const rawHour = Number(end[1]);
    source("dayEnd", `${String(/晚上|晚间/.test(end[0]) && rawHour < 12 ? rawHour + 12 : rawHour).padStart(2, "0")}:00`);
  }
  const lodging = text.match(/(?:住宿|酒店)(?:暂定|定|住)?在\s*([^，。；;\n]{2,20})/);
  if (lodging) source("lodgingArea", lodging[1].trim());
  const excluded = text.match(/(?:不想去|不要去|明确排除|排除)\s*([^，,。；;\n]+)/);
  if (excluded) source("excludedAttractions", splitAttractions(excluded[1]));
  const preferenceTerms = ["自然", "摄影", "拍照", "人文", "历史", "文化", "美食", "夜景", "亲子", "建筑", "博物馆", "徒步"];
  const preferences = preferenceTerms.filter((term) => text.includes(term));
  if (preferences.length) source("preferences", [...new Set(preferences.map((term) => term === "拍照" ? "摄影" : term))]);
  if (/拥挤|人流|避峰|错峰/.test(text)) source("crowdSensitivity", "高");
  if (/天气|下雨|降雨|台风/.test(text)) source("weatherSensitivity", "高");
  return result;
}

export function mergeTravelProfile(input: Record<string, unknown>, extracted: Record<string, unknown>, now = new Date()) {
  const hints = deterministicProfileHints(input.freeText, now);
  const text = clean(input.freeText).slice(0, 5000);
  const sources: Record<string, ProfileFieldSource> = { ...(extracted.fieldSources as Record<string, ProfileFieldSource> || {}), ...hints.fieldSources };
  const pickTextFirst = (field: string, fallback: unknown = "") => {
    if (hints[field] !== undefined && explicit(hints[field])) return hints[field];
    if (explicit(extracted[field])) { sources[field] ||= "ai-text"; return extracted[field]; }
    if (explicit(input[field])) { sources[field] ||= "parameter"; return input[field]; }
    sources[field] ||= "default";
    return fallback;
  };
  const city = explicit(pickTextFirst("city"));
  const startDate = explicit(pickTextFirst("startDate"));
  const days = clamp(pickTextFirst("days", 3), 1, 7, 3);
  const nightsRaw = pickTextFirst("nights", days - 1);
  const partySize = clamp(pickTextFirst("partySize", 2), 1, 20, 2);
  const budgetRaw = Number(pickTextFirst("budget", 0));
  const textPreferences = [...new Set([...list(extracted.preferences), ...list(hints.preferences)])];
  const preferences = textPreferences.length ? textPreferences : list(input.preferences);
  sources.preferences = textPreferences.length ? (hints.preferences ? "text-rule" : "ai-text") : input.preferences ? "parameter" : "default";
  const requiredAttractions = [...new Set([...list(extracted.requiredAttractions), ...list(hints.requiredAttractions)])].slice(0, 12);
  sources.requiredAttractions = hints.requiredAttractions ? "text-rule" : requiredAttractions.length ? "ai-text" : "default";
  const unknownFields = [...new Set(list(extracted.unknownFields))].filter((field) => !(field in hints));
  if (!city && !unknownFields.includes("city")) unknownFields.push("city");
  if (!startDate && !unknownFields.includes("startDate")) unknownFields.push("startDate");
  return {
    city: city.replace(/市$/, ""), startDate, days, nights: clamp(nightsRaw, 0, 7, Math.max(0, days - 1)), partySize,
    budget: Number.isFinite(budgetRaw) && budgetRaw > 0 ? clamp(budgetRaw, 100, 200000, 0) : 0,
    style: explicit(pickTextFirst("style")), preferences,
    avoid: [...new Set(list(extracted.avoid))].slice(0, 8), requiredAttractions,
    pace: clean(pickTextFirst("pace", "medium")) || "medium",
    transport: clean(pickTextFirst("transport", "公共交通优先")) || "公共交通优先",
    hotelPreference: explicit(pickTextFirst("hotelPreference")), lodgingArea: explicit(pickTextFirst("lodgingArea")),
    dayStart: explicit(pickTextFirst("dayStart", "09:00")) || "09:00", dayEnd: explicit(pickTextFirst("dayEnd", "21:00")) || "21:00",
    mealPreference: explicit(pickTextFirst("mealPreference", "每天 1—2 个当地特色美食，顺路安排")) || "每天 1—2 个当地特色美食，顺路安排",
    requestedVariants: list(pickTextFirst("requestedVariants")).length ? list(pickTextFirst("requestedVariants")).slice(0, 3) : ["经典景点覆盖率高", "偏自然和摄影", "避开人流、行程轻松"],
    excludedAttractions: [...new Set([...list(extracted.excludedAttractions), ...list(hints.excludedAttractions)])].slice(0, 12),
    adults: clamp(pickTextFirst("adults", partySize), 0, 20, partySize), children: clamp(pickTextFirst("children", 0), 0, 20, 0), seniors: clamp(pickTextFirst("seniors", 0), 0, 20, 0),
    budgetLevel: explicit(pickTextFirst("budgetLevel")) || "Unknown", interestPriorities: Array.isArray(extracted.interestPriorities) ? extracted.interestPriorities.slice(0, 12) : [],
    crowdSensitivity: explicit(pickTextFirst("crowdSensitivity")) || "Unknown", weatherSensitivity: explicit(pickTextFirst("weatherSensitivity")) || "Unknown", walkingSensitivity: explicit(pickTextFirst("walkingSensitivity")) || "Unknown",
    seasonalNeeds: [...new Set(list(extracted.seasonalNeeds))].slice(0, 10), unknownFields: unknownFields.slice(0, 20), returnTime: explicit(pickTextFirst("returnTime")) || "Unknown",
    clarificationNeeded: Boolean(extracted.clarificationNeeded) && (!city || !startDate) || !city || !startDate,
    clarificationQuestion: !city ? "请先说明一个中国境内的目的城市或区县。" : !startDate ? "请先说明出发日期；支持“8.25出发”“明天出发”等表达。" : clean(extracted.clarificationQuestion),
    fieldSources: sources, freeText: text,
  };
}
