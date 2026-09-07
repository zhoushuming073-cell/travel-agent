import type { TravelProfile } from "./types.ts";

export interface CompiledConstraintModel {
  version: "1.0";
  hardConstraints: Array<{ id: string; field: string; value: unknown; sourcePriority: number }>;
  softConstraints: Array<{ id: string; field: string; value: unknown; penalty: number; sourcePriority: number }>;
  preferences: Array<{ id: string; value: string; weight: number; sourcePriority: number }>;
  assumptions: Array<{ id: string; field: string; value: unknown; sourcePriority: 10 }>;
  unknowns: Array<{ id: string; field: string }>;
  conflicts: Array<{ field: string; kept: unknown; rejected: unknown; reason: string }>;
}

const sourcePriority = (profile: TravelProfile, field: string) => {
  const source = profile.fieldSources?.[field];
  if (source === "text-rule") return 100;
  if (source === "parameter") return 90;
  if (source === "ai-text") return 80;
  if (source === "calculated") return 60;
  return 10;
};

export function compileConstraintModel(profile: TravelProfile): CompiledConstraintModel {
  const hardConstraints: CompiledConstraintModel["hardConstraints"] = [
    { id: "hard:city", field: "city", value: profile.city, sourcePriority: sourcePriority(profile, "city") },
    { id: "hard:startDate", field: "startDate", value: profile.startDate, sourcePriority: sourcePriority(profile, "startDate") },
    { id: "hard:days", field: "days", value: profile.days, sourcePriority: sourcePriority(profile, "days") },
    ...profile.requiredAttractions.map((value, index) => ({ id: `hard:required:${index}`, field: "requiredAttractions", value, sourcePriority: 100 })),
    ...(profile.excludedAttractions || []).map((value, index) => ({ id: `hard:excluded:${index}`, field: "excludedAttractions", value, sourcePriority: 100 })),
  ];
  const softConstraints: CompiledConstraintModel["softConstraints"] = [
    { id: "soft:pace", field: "pace", value: profile.pace || "moderate", penalty: 18, sourcePriority: sourcePriority(profile, "pace") },
    { id: "soft:walking", field: "walkingSensitivity", value: profile.walkingSensitivity || "medium", penalty: 16, sourcePriority: sourcePriority(profile, "walkingSensitivity") },
    { id: "soft:crowd", field: "crowdSensitivity", value: profile.crowdSensitivity || "medium", penalty: 14, sourcePriority: sourcePriority(profile, "crowdSensitivity") },
    { id: "soft:budget", field: "budget", value: profile.budget ?? null, penalty: 20, sourcePriority: sourcePriority(profile, "budget") },
  ];
  const preferences = profile.preferences.map((value, index) => ({ id: `preference:${index}`, value, weight: Number(profile.interestPriorities?.find((item) => item.name === value)?.priority || 0.7), sourcePriority: 100 }));
  const assumptions = [
    { id: "assumption:dayStart", field: "dayStart", value: profile.dayStart || "09:00", sourcePriority: 10 as const },
    { id: "assumption:dayEnd", field: "dayEnd", value: profile.dayEnd || "21:00", sourcePriority: 10 as const },
    { id: "assumption:lunch", field: "lunchWindow", value: "11:30-13:30", sourcePriority: 10 as const },
    { id: "assumption:dinner", field: "dinnerWindow", value: "17:30-20:00", sourcePriority: 10 as const },
  ];
  const required = new Set(profile.requiredAttractions.map((value) => value.replace(/\s+/g, "")));
  const conflicts = (profile.excludedAttractions || [])
    .filter((value) => required.has(value.replace(/\s+/g, "")))
    .map((value) => ({ field: "attractions", kept: value, rejected: value, reason: `地点“${value}”同时被列为必去和排除；显式冲突必须由用户解决，优化器不得用分数抵消。` }));
  const unknowns = (profile.unknownFields || []).map((field, index) => ({ id: `unknown:${index}`, field }));
  return { version: "1.0", hardConstraints, softConstraints, preferences, assumptions, unknowns, conflicts };
}
