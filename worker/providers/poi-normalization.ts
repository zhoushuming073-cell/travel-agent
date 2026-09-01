/* eslint-disable @typescript-eslint/no-explicit-any -- external map and encyclopedia payloads do not share a stable schema */
import { cleanText, normalizeName } from "../lib/value-utils.ts";

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

function wikiCategory(title: string, extract: string) {
  const text = `${title} ${extract}`;
  if (/湖|山|峰|洞|瀑布|湿地|公园|花园|园林|岛|堤|自然保护区|风景区/.test(text)) return "自然景观";
  if (/博物馆|美术馆|纪念馆|展览馆|科技馆/.test(text)) return "博物展馆";
  if (/寺|庙|塔|教堂|故居|遗址|古镇|古城|祠|陵|历史|文化遗产|世界遗产/.test(text)) return "历史文化";
  return "城市景观";
}

export function wikiPageToSpot(page: any, city: any, requiredNames: string[], preferences: string[] = []) {
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

export function amapCandidateRecord(row: any, city: any, requiredNames: string[]) {
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

export function nominatimCandidateRecord(row: any, city: any, requiredNames: string[]) {
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

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
