import type { AgentEvent, AgentState, ItineraryPlan, TravelProfile } from "./types.ts";

function event(
  workspaceId: string,
  index: number,
  state: AgentState,
  title: string,
  detail: string,
  progress: number,
  createdAt: string,
): AgentEvent {
  return { id: `${workspaceId}-event-${index}`, workspaceId, type: state.toLowerCase(), state, title, detail, progress, createdAt };
}

export function buildPlanningEvents(workspaceId: string, profile: TravelProfile, plan: ItineraryPlan): AgentEvent[] {
  const createdAt = plan.generatedAt;
  return [
    event(workspaceId, 1, "BUILDING_PROFILE", "已完成需求结构化", `识别 ${profile.city} · ${profile.days} 天 · ${profile.requiredAttractions.length} 个必选景点`, 12, createdAt),
    event(workspaceId, 2, "FETCHING_DATA", "已完成现实信息采集", `取得 ${plan.travelFacts?.length ?? 0} 条 Travel Fact，并保留无法核验的数据为 Unknown`, 32, createdAt),
    event(workspaceId, 3, "ASSESSING_EVIDENCE", "已建立证据关系", `${plan.evidenceGraph?.sourceCount ?? 0} 个来源 → ${plan.evidenceGraph?.factCount ?? 0} 条事实 → ${plan.evidenceGraph?.itineraryNodeCount ?? 0} 个行程节点`, 48, createdAt),
    event(workspaceId, 4, "VALIDATING_ITINERARY", "Travel Compiler 2.0 已完成", `${plan.compiler?.issues.length ?? 0} 个问题 · 最小缓冲 ${plan.bufferAnalysis?.minBufferMinutes ?? 0} 分钟`, 64, createdAt),
    event(workspaceId, 5, "ANALYZING_UNCERTAINTY", "已完成未知项优先级分析", `${plan.uncertainty?.importantCount ?? 0} 个关键未知 · 最少核验 ${plan.minimumVerification?.length ?? 0} 项`, 76, createdAt),
    event(workspaceId, 6, "ANALYZING_FRAGILITY", "已完成依赖与脆弱性分析", `脆弱性 ${plan.fragility?.score ?? 0} · 关键路径 ${plan.criticalPath?.nodeIds.length ?? 0} 个节点`, 88, createdAt),
    event(workspaceId, 7, "STRESS_TESTING", "已完成节点级情景模拟", `${plan.stressTest?.scenarios.length ?? 0} 个扰动情景，明确标注为 Simulation`, 96, createdAt),
    event(workspaceId, 8, "READY", "工作台已就绪", "可比较三套方案、查看证据并通过自然语言进行局部调整", 100, createdAt),
  ];
}

