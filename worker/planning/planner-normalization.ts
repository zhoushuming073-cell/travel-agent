/* eslint-disable @typescript-eslint/no-explicit-any -- model responses are normalized from untyped provider JSON at this boundary */
import { openingRange } from "../domain/planner-v4.ts";
import { optimizeRouteBuckets } from "../domain/route-optimizer.ts";
import { materializeSelectedSparseLegs } from "../domain/sparse-transit.ts";
import { clamp, cleanText, list, minutesToTime, timeToMinutes } from "../lib/value-utils.ts";
export function compactPlannerKnowledge(knowledge: any) {
  const matrix = knowledge?.trafficMatrix || {};
  const requiredIds = new Set((knowledge?.spots || []).filter((spot: any) => spot.requiredByUser).map((spot: any) => spot.id));
  const selected: any[] = [];
  const seen = new Set<string>();
  const add = (leg: any) => {
    const key = `${leg.fromId}->${leg.toId}`;
    if (!seen.has(key)) { seen.add(key); selected.push(leg); }
  };
  for (const leg of matrix.legs || []) {
    if (leg.fromId === "hotel" || leg.toId === "hotel" || requiredIds.has(leg.fromId) || requiredIds.has(leg.toId)) add(leg);
  }
  const byOrigin = new Map<string, any[]>();
  for (const leg of matrix.legs || []) {
    const rows = byOrigin.get(leg.fromId) || [];
    rows.push(leg);
    byOrigin.set(leg.fromId, rows);
  }
  for (const rows of byOrigin.values()) {
    rows.sort((left, right) => Number(left.durationMin || 9999) - Number(right.durationMin || 9999)).slice(0, 4).forEach(add);
  }
  return {
    ...knowledge,
    trafficMatrix: { ...matrix, legs: selected.slice(0, 120), totalCandidateLegs: matrix.legs?.length || 0, compactedForModel: true },
    modelInputPolicy: "交通矩阵只向模型提供酒店/必选相关段和各点最近邻；完整矩阵仍由 Travel Compiler 审计与最终核验使用",
  };
}

function modelArray(value: any, keys: string[]) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  if (value && typeof value === "object") {
    const ordered = Object.entries(value)
      .filter(([key, row]) => /^(?:day|d|第)?\s*\d+\s*(?:天)?$/i.test(key) && row && typeof row === "object")
      .sort(([left], [right]) => Number(left.match(/\d+/)?.[0] || 0) - Number(right.match(/\d+/)?.[0] || 0))
      .map(([, row]) => row);
    if (ordered.length) return ordered;
  }
  return [];
}

function modelVariants(value: any) {
  const direct = modelArray(value, ["variants", "plans", "alternatives"]);
  if (direct.length) return direct;
  const named = [value?.hot, value?.niche, value?.relax, value?.classic, value?.nature, value?.easy].filter(Boolean);
  if (named.length) return named;
  return value?.variant || value?.plan || value?.result ? [value.variant || value.plan || value.result] : [];
}

function modelDays(value: any) {
  return modelArray(value, ["days", "daysPlan", "dayPlans", "dailyPlans", "daily_plans", "itinerary"]);
}

function modelActivities(value: any) {
  return modelArray(value, ["activities", "items", "schedule", "timeline", "events"]);
}

function normalizePlannerDraft(value: any, profile: any) {
  const variants = modelVariants(value).slice(0, 3);
  return {
    variants: variants.map((variant: any, variantIndex: number) => ({
      id: ["hot", "niche", "relax"][variantIndex],
      title: cleanText(variant?.title, ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex]),
      style: cleanText(variant?.style, ["经典", "自然摄影", "轻松避峰"][variantIndex]),
      strategy: cleanText(variant?.strategy),
      days: modelDays(variant).slice(0, profile.days).map((day: any, dayIndex: number) => ({
        day: dayIndex + 1,
        theme: cleanText(day?.theme, `第 ${dayIndex + 1} 天`),
        returnHotelTime: cleanText(day?.returnHotelTime, profile.dayEnd),
        totalActivityMin: clamp(day?.totalActivityMin, 0, 900),
        totalTransportMin: clamp(day?.totalTransportMin, 0, 600),
        activities: modelActivities(day).slice(0, 12).map((activity: any) => ({
          type: ["attraction", "meal", "rest"].includes(cleanText(activity?.type)) ? cleanText(activity.type) : cleanText(activity?.spotId || activity?.poiId || activity?.placeId) ? "attraction" : /餐|午饭|晚饭|用餐/.test(cleanText(activity?.label || activity?.name)) ? "meal" : "rest",
          spotId: cleanText(activity?.spotId || activity?.poiId || activity?.placeId) || undefined,
          label: cleanText(activity?.label || activity?.name) || undefined,
          startTime: cleanText(activity?.startTime || activity?.start), endTime: cleanText(activity?.endTime || activity?.end),
          durationMin: clamp(activity?.durationMin || activity?.duration, 15, 360),
          transportFromPrevious: activity?.transportFromPrevious || activity?.transit ? {
            mode: cleanText((activity.transportFromPrevious || activity.transit).mode, "公共交通"),
            durationMin: clamp((activity.transportFromPrevious || activity.transit).durationMin || (activity.transportFromPrevious || activity.transit).minutes, 1, 360),
            matrixKey: cleanText((activity.transportFromPrevious || activity.transit).matrixKey) || undefined,
          } : undefined,
          reason: cleanText(activity?.reason, "依据候选景点知识包与交通矩阵"),
          evidenceRefs: list(activity?.evidenceRefs).slice(0, 8),
          alternativeSpotIds: list(activity?.alternativeSpotIds).slice(0, 4),
          adjustmentCondition: cleanText(activity?.adjustmentCondition) || undefined,
        })),
      })),
    })),
  };
}

export function normalizePlannerVariant(value: any, profile: any, variantIndex: number) {
  const variantId = ["hot", "niche", "relax"][variantIndex];
  const rawVariant = modelVariants(value)[0] || value?.[variantId] || value?.variant || value?.plan || value?.result || value;
  const normalized = normalizePlannerDraft({ variants: [rawVariant] }, profile).variants[0];
  if (!normalized) return null;
  return {
    ...normalized,
    id: ["hot", "niche", "relax"][variantIndex],
    title: cleanText(rawVariant?.title, ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex]),
    style: cleanText(rawVariant?.style, ["经典", "自然摄影", "轻松避峰"][variantIndex]),
  };
}

export function normalizePlannerSkeleton(value: any, profile: any, variantIndex: number) {
  const variantId = ["hot", "niche", "relax"][variantIndex];
  const raw = value?.skeleton || modelVariants(value)[0] || value?.[variantId] || value?.variant || value?.plan || value;
  const selectedSpotIds = [...new Set([
    ...list(raw?.selectedSpotIds),
    ...list(raw?.spotIds),
    ...modelDays(raw).flatMap((day: any) => modelActivities(day).map((activity: any) => cleanText(activity?.spotId || activity?.poiId || activity?.placeId))),
  ].map((item) => cleanText(item)).filter(Boolean))];
  return {
    id: variantId,
    title: cleanText(raw?.title, ["经典覆盖", "自然摄影", "轻松避峰"][variantIndex]),
    style: cleanText(raw?.style, ["经典", "自然摄影", "轻松避峰"][variantIndex]),
    strategy: cleanText(raw?.strategy),
    dayThemes: list(raw?.dayThemes).slice(0, Number(profile.days || 1)),
    days: [{ day: 1, activities: selectedSpotIds.map((spotId) => ({ type: "attraction", spotId })) }],
  };
}

export function completePlannerVariant(variant: any, profile: any) {
  return Boolean(variant && variant.days?.length === Number(profile.days) && variant.days.every((day: any, index: number) => Number(day.day) === index + 1 && Array.isArray(day.activities) && day.activities.length > 0));
}

export function recoverPlannerVariant(profile: any, knowledge: any, variantIndex: number, partial: any, reason = "模型输出结构不完整", previousVariantSpotIds: string[] = []) {
  const ids = ["hot", "niche", "relax"];
  const titles = ["经典覆盖", "自然摄影", "轻松避峰"];
  const styles = ["经典", "自然摄影", "轻松避峰"];
  const variantId = ids[variantIndex];
  const modelChosenIds = (partial?.days || []).flatMap((day: any) => (day.activities || []).map((activity: any) => cleanText(activity.spotId)).filter(Boolean));
  const optimized = optimizeRouteBuckets({ profile, knowledge, objective: variantId as any, seedIds: modelChosenIds, previousVariantSpotIds });
  const buckets = optimized.dayBuckets;
  const dayStart = timeToMinutes(profile.dayStart, 9 * 60);
  const dayEnd = timeToMinutes(profile.dayEnd, 21 * 60);
  const days = buckets.map((daySpots, dayIndex) => {
    const mealLandmark = daySpots.find((spot: any) => spot.timeRole === "meal-landmark");
    const nightscape = daySpots.find((spot: any) => spot.timeRole === "nightscape");
    const regular = daySpots.filter((spot: any) => spot !== mealLandmark && spot !== nightscape);
    const activities: any[] = [];
    let cursor = dayStart;
    for (const spot of regular.slice(0, 1)) {
      const duration = 90;
      activities.push({ type: "attraction", spotId: spot.id, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + duration), durationMin: duration, reason: "保留模型已选/高优先候选，由可靠性编译器补全缺失日期", evidenceRefs: [spot.id], alternativeSpotIds: [] });
      cursor += duration;
    }
    const lunchStart = Math.max(11 * 60 + 30, cursor + 20);
    activities.push(mealLandmark
      ? { type: "meal", spotId: mealLandmark.id, label: `${mealLandmark.name}用餐`, startTime: minutesToTime(lunchStart), endTime: minutesToTime(lunchStart + 75), durationMin: 75, reason: "餐饮型必去点进入正常饭点", evidenceRefs: [mealLandmark.id], alternativeSpotIds: [] }
      : { type: "meal", label: "午餐与休息", startTime: minutesToTime(lunchStart), endTime: minutesToTime(lunchStart + 75), durationMin: 75, reason: "可靠性编译器保留正常用餐", evidenceRefs: [] });
    cursor = lunchStart + 95;
    for (const spot of regular.slice(1)) {
      if (cursor + 90 > Math.min(dayEnd - 30, 17 * 60 + 30)) break;
      activities.push({ type: "attraction", spotId: spot.id, startTime: minutesToTime(cursor), endTime: minutesToTime(cursor + 90), durationMin: 90, reason: "保留模型已选/高优先候选，并控制单日密度", evidenceRefs: [spot.id], alternativeSpotIds: [] });
      cursor += 115;
    }
    if (nightscape) {
      const sunset = timeToMinutes(knowledge?.weather?.[dayIndex]?.sunset, 18 * 60) + 25;
      const start = Math.max(cursor, sunset, 18 * 60);
      if (start + 90 <= dayEnd) activities.push({ type: "attraction", spotId: nightscape.id, startTime: minutesToTime(start), endTime: minutesToTime(start + 90), durationMin: 90, reason: "夜景型地点安排在日落后", evidenceRefs: [nightscape.id], alternativeSpotIds: [] });
    }
    const lastEnd = activities.reduce((latest, activity) => Math.max(latest, timeToMinutes(activity.endTime, latest)), dayStart);
    if (lastEnd + 30 <= dayEnd) activities.push({ type: "rest", label: "弹性缓冲 / 返回住宿地", startTime: minutesToTime(lastEnd), endTime: minutesToTime(lastEnd + 30), durationMin: 30, reason: "为交通波动和临时调整预留缓冲", evidenceRefs: [] });
    return { day: dayIndex + 1, theme: cleanText(partial?.dayThemes?.[dayIndex], `${titles[variantIndex]} · 第 ${dayIndex + 1} 天`), returnHotelTime: minutesToTime(Math.min(dayEnd, lastEnd + 30)), totalActivityMin: activities.reduce((sum, activity) => sum + Number(activity.durationMin || 0), 0), totalTransportMin: 0, activities };
  });
  return {
    id: variantId,
    title: cleanText(partial?.title, titles[variantIndex]),
    style: cleanText(partial?.style, styles[variantIndex]),
    strategy: `${cleanText(partial?.strategy, titles[variantIndex])}；模型响应结构异常后由可靠性编译器内置的多目标路线优化器按偏好、客流、时令、交通聚类和方案差异补全时间轴`,
    days,
    recoveryReason: cleanText(reason),
    optimizationDiagnostics: optimized.diagnostics,
    objectiveScore: optimized.objectiveScore,
  };
}

export function enforceRequiredCoverage(draft: any, knowledge: any) {
  const requiredSpots = list<any>(knowledge?.spots).filter((spot) => spot.requiredByUser && cleanText(spot.id));
  const spotMap = new Map<string, any>(list<any>(knowledge?.spots).map((spot) => [cleanText(spot.id), spot]));
  const matrix = knowledge?.trafficMatrix;
  const changes: any[] = [];
  if (!requiredSpots.length) return { replaced: 0, rebuilt: 0, changes };

  const legMinutes = (fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return 0;
    const leg = list<any>(matrix?.legs).find((item) => (item.fromId === fromId && item.toId === toId) || (item.fromId === toId && item.toId === fromId));
    return Number(leg?.durationMin || 45);
  };

  for (let variantIndex = 0; variantIndex < list<any>(draft?.variants).length; variantIndex += 1) {
    let variant = draft.variants[variantIndex];
    const selected = new Set(list(variant?.days).flatMap((day: any) => list(day.activities).map((activity: any) => cleanText(activity.spotId)).filter(Boolean)));
    let missing = requiredSpots.filter((spot: any) => !selected.has(spot.id));
    for (const required of missing) {
      const candidates = list(variant?.days).flatMap((day: any) => list(day.activities).map((activity: any) => ({ day, activity, spot: spotMap.get(cleanText(activity.spotId)) })))
        .filter((entry: any) => entry.activity?.spotId && !entry.spot?.requiredByUser && !["meal-landmark", "nightscape"].includes(cleanText(entry.spot?.timeRole)))
        .sort((left: any, right: any) => {
          const score = (entry: any) => {
            const neighborIds = list(entry.day?.activities).map((activity: any) => cleanText(activity.spotId)).filter((id: string) => id && id !== cleanText(entry.activity.spotId));
            const proximity = neighborIds.length ? Math.min(...neighborIds.map((id: string) => legMinutes(required.id, id))) : 30;
            const valuePenalty = Number(entry.spot?.plannerScore || 0) * 0.2;
            return (entry.spot ? 0 : -100) + proximity + valuePenalty;
          };
          return score(left) - score(right);
        });
      const replacement = candidates[0];
      if (!replacement) break;
      const previousId = cleanText(replacement.activity.spotId);
      const start = timeToMinutes(replacement.activity.startTime, timeToMinutes(knowledge?.profile?.dayStart, 9 * 60));
      const end = timeToMinutes(replacement.activity.endTime, start + Number(replacement.activity.durationMin || 90));
      replacement.activity.type = required.timeRole === "meal-landmark" ? "meal" : "attraction";
      replacement.activity.spotId = required.id;
      replacement.activity.durationMin = Math.max(60, end - start || Math.min(120, Number(required.recommendedDurationMin || 90)));
      replacement.activity.endTime = minutesToTime(start + replacement.activity.durationMin);
      replacement.activity.reason = "用户明确指定的必选项；硬约束编译器将模型遗漏实体绑定到原有可执行时段";
      replacement.activity.evidenceRefs = [...new Set([required.id, ...list(replacement.activity.evidenceRefs)])];
      replacement.activity.alternativeSpotIds = [...new Set([previousId, ...list(replacement.activity.alternativeSpotIds)].filter(Boolean))];
      delete replacement.activity.transportFromPrevious;
      if (replacement.activity.type === "meal") replacement.activity.label = `${required.name}用餐`;
      selected.delete(previousId);
      selected.add(required.id);
      changes.push({ variantId: variant.id, action: "replaced", requiredSpotId: required.id, requiredSpotName: required.name, replacedSpotId: previousId, day: replacement.day.day });
    }

    missing = requiredSpots.filter((spot: any) => !selected.has(spot.id));
    if (missing.length) {
      const previousVariantSpotIds = list(draft?.variants).slice(0, variantIndex).flatMap((item: any) => list(item.days).flatMap((day: any) => list(day.activities).map((activity: any) => cleanText(activity.spotId)).filter(Boolean)));
      variant = recoverPlannerVariant(knowledge.profile || {}, knowledge, variantIndex, variant, `模型草案遗漏必选实体：${missing.map((spot: any) => spot.name).join("、")}`, previousVariantSpotIds);
      draft.variants[variantIndex] = variant;
      changes.push({ variantId: variant.id, action: "rebuilt", requiredSpotIds: missing.map((spot: any) => spot.id), requiredSpotNames: missing.map((spot: any) => spot.name) });
    }
  }
  return {
    replaced: changes.filter((change) => change.action === "replaced").length,
    rebuilt: changes.filter((change) => change.action === "rebuilt").length,
    changes,
  };
}

export function bindTrafficMatrixFacts(draft: any, knowledge: any) {
  const matrix = knowledge?.trafficMatrix;
  if (!matrix?.legs?.length) return draft;
  materializeSelectedSparseLegs(draft, knowledge);
  for (const variant of draft.variants || []) {
    for (const day of variant.days || []) {
      const spotActivities = (day.activities || [])
        .filter((activity: any) => Boolean(activity.spotId))
        .sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
      for (let index = 1; index < spotActivities.length; index += 1) {
        const previous = spotActivities[index - 1];
        const current = spotActivities[index];
        const leg = matrix.legs.find((item: any) => item.fromId === previous.spotId && item.toId === current.spotId)
          || matrix.legs.find((item: any) => item.fromId === current.spotId && item.toId === previous.spotId);
        if (!leg || current.transportFromPrevious) continue;
        current.transportFromPrevious = {
          mode: "公共交通 / 步行（以地图复核为准）",
          durationMin: Number(leg.durationMin),
          matrixKey: `${previous.spotId}->${current.spotId}`,
        };
      }
      day.totalTransportMin = spotActivities.slice(1).reduce((sum: number, activity: any) => sum + Number(activity.transportFromPrevious?.durationMin || 0), 0);
    }
  }
  return draft;
}

export function legalizePlannerTimelines(draft: any, knowledge: any) {
  const matrix = knowledge?.trafficMatrix;
  const spotMap = new Map((knowledge?.spots || []).map((spot: any) => [spot.id, spot]));
  let shiftedActivities = 0;
  let shiftedMinutes = 0;
  for (const variant of draft.variants || []) {
    for (const day of variant.days || []) {
      const ordered = [...(day.activities || [])]
        .sort((left: any, right: any) => timeToMinutes(left.startTime, 0) - timeToMinutes(right.startTime, 0));
      let previousEnd = 0;
      let previousSpot: any = null;
      for (const activity of ordered) {
        const originalStart = timeToMinutes(activity.startTime, previousEnd);
        const originalEnd = timeToMinutes(activity.endTime, originalStart + Number(activity.durationMin || 0));
        const durationFromTimes = originalEnd - originalStart;
        const duration = durationFromTimes > 0 ? durationFromTimes : Math.max(15, Number(activity.durationMin || 0));
        let minimumStart = previousEnd;
        const semanticSpot: any = activity.spotId ? spotMap.get(activity.spotId) : null;
        if (semanticSpot?.timeRole === "nightscape") {
          minimumStart = Math.max(minimumStart, timeToMinutes(knowledge?.weather?.[day.day - 1]?.sunset, 18 * 60) + 25);
        }
        if (semanticSpot?.timeRole === "meal-landmark") {
          if (originalStart < 11 * 60 + 30) minimumStart = Math.max(minimumStart, 11 * 60 + 30);
          else if (originalStart > 13 * 60 + 30 && originalStart < 17 * 60 + 30) minimumStart = Math.max(minimumStart, 17 * 60 + 30);
        }
        if (activity.spotId && previousSpot?.spotId && matrix?.legs?.length) {
          const leg = matrix.legs.find((item: any) => item.fromId === previousSpot.spotId && item.toId === activity.spotId)
            || matrix.legs.find((item: any) => item.fromId === activity.spotId && item.toId === previousSpot.spotId);
          if (leg) minimumStart = Math.max(minimumStart, previousSpot.end + Number(leg.durationMin));
        }
        const legalizedStart = Math.max(originalStart, minimumStart);
        if (legalizedStart > originalStart) {
          shiftedActivities += 1;
          shiftedMinutes += legalizedStart - originalStart;
          activity.startTime = minutesToTime(legalizedStart);
          activity.endTime = minutesToTime(legalizedStart + duration);
        }
        activity.durationMin = duration;
        const legalizedEnd = legalizedStart + duration;
        previousEnd = legalizedEnd;
        if (activity.spotId) previousSpot = { spotId: activity.spotId, end: legalizedEnd };
      }
      day.activities = ordered;
    }
  }
  return { shiftedActivities, shiftedMinutes };
}

export function applyFinalTimelineSafetyRepair(draft: any, knowledge: any) {
  const profile = knowledge?.profile || {};
  const startLimit = timeToMinutes(profile.dayStart, 9 * 60);
  const endLimit = timeToMinutes(profile.dayEnd, 21 * 60);
  const spotMap = new Map((knowledge?.spots || []).map((spot: any) => [spot.id, spot]));
  const matrix = knowledge?.trafficMatrix;
  let insertedLunches = 0;
  let insertedDinners = 0;
  let removedFlexibleStops = 0;
  let reflowedActivities = 0;

  const reflow = (day: any, activities: any[]) => {
    const mealRole = (activity: any) => {
      if (activity.type !== "meal") return "";
      const label = cleanText(activity.label);
      const start = timeToMinutes(activity.startTime, -1);
      if (/晚餐/.test(label) || start >= 17 * 60) return "dinner";
      if (/午餐/.test(label) || (start >= 11 * 60 && start <= 13 * 60 + 30)) return "lunch";
      return "";
    };
    const sortTime = (activity: any) => {
      const role = mealRole(activity);
      if (role === "lunch") return 12 * 60;
      if (role === "dinner") return 17 * 60 + 30;
      const start = timeToMinutes(activity.startTime, startLimit);
      const end = timeToMinutes(activity.endTime, start);
      // A model can serialize an after-midnight end as 01:00. Keep that block at
      // the end of this travel day so it cannot jump ahead of lunch on reflow.
      if (end < start || start < 5 * 60) return start + 24 * 60;
      return start;
    };
    const ordered = [...activities].sort((left: any, right: any) => sortTime(left) - sortTime(right));
    let cursor = startLimit;
    let previousSpot: any = null;
    for (const activity of ordered) {
      const originalStart = timeToMinutes(activity.startTime, cursor);
      const originalEnd = timeToMinutes(activity.endTime, originalStart + Number(activity.durationMin || 60));
      const semanticSpot: any = activity.spotId ? spotMap.get(activity.spotId) : null;
      let duration = Math.max(15, originalEnd - originalStart || Number(activity.durationMin || 60));
      if (activity.type === "meal") duration = Math.min(90, Math.max(60, duration));
      else if (activity.type === "rest") duration = Math.min(45, Math.max(20, duration));
      else duration = Math.min(semanticSpot?.requiredByUser ? 120 : 100, Math.max(semanticSpot?.requiredByUser ? 60 : 45, duration));
      let minimumStart = cursor;
      const open = openingRange(semanticSpot?.openingHours);
      if (open) minimumStart = Math.max(minimumStart, open[0]);
      const role = mealRole(activity);
      if (role === "lunch") minimumStart = Math.max(minimumStart, 11 * 60 + 30);
      if (role === "dinner") minimumStart = Math.max(minimumStart, 17 * 60 + 30);
      if (semanticSpot?.timeRole === "meal-landmark") {
        activity.type = "meal";
        minimumStart = Math.max(minimumStart, originalStart <= 14 * 60 ? 11 * 60 + 30 : 17 * 60 + 30);
      }
      if (semanticSpot?.timeRole === "nightscape") minimumStart = Math.max(minimumStart, timeToMinutes(knowledge?.weather?.[day.day - 1]?.sunset, 18 * 60) + 25);
      if (activity.spotId && previousSpot?.spotId && matrix?.legs?.length) {
        const leg = matrix.legs.find((item: any) => item.fromId === previousSpot.spotId && item.toId === activity.spotId)
          || matrix.legs.find((item: any) => item.fromId === activity.spotId && item.toId === previousSpot.spotId);
        if (leg) {
          minimumStart = Math.max(minimumStart, previousSpot.end + Number(leg.durationMin));
          activity.transportFromPrevious = { mode: "公共交通 / 步行（以地图复核为准）", durationMin: Number(leg.durationMin), matrixKey: `${previousSpot.spotId}->${activity.spotId}` };
        }
      }
      const start = minimumStart;
      activity.startTime = minutesToTime(start);
      activity.endTime = minutesToTime(start + duration);
      activity.durationMin = duration;
      cursor = start + duration;
      if (activity.spotId) previousSpot = { spotId: activity.spotId, end: cursor };
      reflowedActivities += 1;
    }
    day.activities = ordered;
    day.returnHotelTime = minutesToTime(Math.min(endLimit, Math.max(cursor, timeToMinutes(day.returnHotelTime, cursor))));
    return cursor;
  };

  for (const variant of draft.variants || []) {
    for (const day of variant.days || []) {
      let activities = [...(day.activities || [])];
      const hasLunch = activities.some((activity: any) => activity.type === "meal" && (() => { const start = timeToMinutes(activity.startTime, -1); return start >= 11 * 60 && start <= 13 * 60 + 30; })());
      if (!hasLunch) {
        activities.push({ type: "meal", label: "午餐与休息", startTime: "12:00", endTime: "13:00", durationMin: 60, reason: "最终编译器补齐正常午餐，不跨区追店", evidenceRefs: [] });
        insertedLunches += 1;
      }
      const plannedEnd = activities.reduce((latest: number, activity: any) => {
        const start = timeToMinutes(activity.startTime, 0);
        const rawEnd = timeToMinutes(activity.endTime, start);
        const end = rawEnd < start ? rawEnd + 24 * 60 : rawEnd;
        return Math.max(latest, start, end);
      }, 0);
      const hasDinner = activities.some((activity: any) => activity.type === "meal" && (() => { const start = timeToMinutes(activity.startTime, -1); return start >= 17 * 60 && start <= 20 * 60; })());
      if (plannedEnd > 18 * 60 && !hasDinner) {
        activities.push({ type: "meal", label: "晚餐与休息", startTime: "17:30", endTime: "18:30", durationMin: 60, reason: "最终编译器为延续到晚间的行程补齐顺路晚餐", evidenceRefs: [] });
        insertedDinners += 1;
      }
      let end = reflow(day, activities);
      while (end > endLimit) {
        const removable = [...day.activities].reverse().find((activity: any) => {
          if (!activity.spotId) return activity.type === "rest";
          const spot: any = spotMap.get(activity.spotId);
          return !spot?.requiredByUser && !["meal-landmark", "nightscape"].includes(cleanText(spot?.timeRole));
        });
        if (!removable) break;
        activities = day.activities.filter((activity: any) => activity !== removable);
        removedFlexibleStops += 1;
        end = reflow(day, activities);
      }
    }
  }
  return { insertedLunches, insertedDinners, removedFlexibleStops, reflowedActivities };
}
