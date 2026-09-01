export type PlanningObjective = "hot" | "niche" | "relax";

export interface PreferenceProfile {
  interests: Array<{ id: string; label: string; weight: number; terms: string[] }>;
  avoidTerms: string[];
  crowdSensitivity: number;
  walkingSensitivity: number;
}

export interface PreferenceScore {
  score: number;
  matched: string[];
  avoided: string[];
  contributions: Array<{ id: string; label: string; points: number; evidence: string }>;
}

const ONTOLOGY: Record<string, string[]> = {
  自然: ["自然", "山", "湖", "江", "海", "湿地", "森林", "公园", "植物", "风景", "溪", "谷"],
  摄影: ["摄影", "拍照", "山", "湖", "江", "海", "古镇", "建筑", "夜景", "观景", "日落", "花"],
  人文: ["人文", "文化", "历史", "博物", "古城", "古镇", "遗址", "寺", "故居", "建筑", "非遗"],
  文化: ["文化", "历史", "博物", "非遗", "遗址", "寺", "古建", "故居"],
  亲子: ["亲子", "动物", "植物", "科技", "海洋", "乐园", "公园", "博物"],
  夜景: ["夜景", "城市夜景", "广场", "滨水", "步行街", "古城", "塔", "地标", "灯光"],
  美食: ["美食", "小吃", "餐厅", "饭店", "茶", "菜馆", "夜市"],
};

const normalize = (value: unknown) => String(value ?? "").trim();
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(normalize).filter(Boolean) : [];
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(value)));
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export function buildPreferenceProfile(profile: unknown): PreferenceProfile {
  const profileRecord = record(profile);
  const priorities = Array.isArray(profileRecord.interestPriorities) ? profileRecord.interestPriorities.map(record) : [];
  const raw = [...new Set([normalize(profileRecord.style), ...list(profileRecord.preferences), ...priorities.map((item) => normalize(item.name))].filter(Boolean))];
  const interests = raw.map((label) => {
    const explicit = priorities.find((item) => normalize(item.name) === label);
    const rawWeight = Number(explicit?.priority ?? explicit?.weight ?? 0.7);
    return { id: label, label, weight: Math.max(0.15, Math.min(1, rawWeight > 1 ? rawWeight / 100 : rawWeight)), terms: ONTOLOGY[label] || [label] };
  });
  return {
    interests,
    avoidTerms: list(profileRecord.avoid),
    crowdSensitivity: profileRecord.crowdSensitivity === "high" || list(profileRecord.avoid).some((term) => /拥挤|排队|人流/.test(term)) ? 1 : profileRecord.crowdSensitivity === "low" ? 0.2 : 0.55,
    walkingSensitivity: profileRecord.walkingSensitivity === "high" ? 1 : profileRecord.walkingSensitivity === "low" ? 0.2 : 0.5,
  };
}

export function scorePreferenceMatch(spot: unknown, preference: PreferenceProfile, objective: PlanningObjective = "hot"): PreferenceScore {
  const spotRecord = record(spot);
  const text = [spotRecord.name, spotRecord.officialName, spotRecord.category, spotRecord.extract, spotRecord.address, ...list(spotRecord.tags)].map(normalize).join(" ");
  const contributions: PreferenceScore["contributions"] = [];
  const matched: string[] = [];
  let earned = 0;
  let possible = 0;
  for (const interest of preference.interests) {
    const objectiveBoost = objective === "niche" && /自然|摄影|花|秋/.test(interest.label) ? 1.25 : objective === "hot" && /人文|文化|经典/.test(interest.label) ? 1.12 : 1;
    const weight = interest.weight * objectiveBoost;
    possible += weight;
    const hits = interest.terms.filter((term) => text.includes(term));
    if (!hits.length) continue;
    const strength = Math.min(1, 0.65 + hits.length * 0.12);
    earned += weight * strength;
    matched.push(interest.label);
    contributions.push({ id: `interest:${interest.id}`, label: `匹配${interest.label}`, points: Math.round(weight * strength * 45), evidence: hits.slice(0, 4).join(" / ") });
  }
  const avoided = preference.avoidTerms.filter((term) => term && text.includes(term));
  if (avoided.length) contributions.push({ id: "avoid", label: "命中回避偏好", points: -Math.min(35, avoided.length * 15), evidence: avoided.join(" / ") });
  const crowd = Number(record(spotRecord.crowdRisk).score ?? record(spotRecord.crowd).score);
  if (Number.isFinite(crowd) && preference.crowdSensitivity > 0.5) {
    const points = -Math.round(Math.max(0, crowd - 45) * 0.25 * preference.crowdSensitivity * (objective === "relax" ? 1.4 : 1));
    if (points) contributions.push({ id: "crowd", label: "拥挤敏感修正", points, evidence: `预测风险 ${Math.round(crowd)}%` });
  }
  const base = preference.interests.length ? 35 + 65 * earned / Math.max(0.1, possible) : 60;
  return { score: clamp(base + contributions.filter((item) => item.points < 0).reduce((sum, item) => sum + item.points, 0)), matched, avoided, contributions };
}
