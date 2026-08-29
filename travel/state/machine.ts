import type { AgentState } from "../types.ts";

export const WORKSPACE_STAGES: Record<AgentState, { label: string; eyebrow: string; title: string; flow: number }> = {
  EMPTY: { label: "等待输入", eyebrow: "NEW TRIP", title: "开始一段新旅行", flow: -1 },
  COLLECTING_REQUIREMENTS: { label: "补充需求", eyebrow: "REQUIREMENTS", title: "正在补充旅行需求", flow: 0 },
  BUILDING_PROFILE: { label: "理解需求", eyebrow: "STAGE 1 / PROFILE", title: "AI 正在理解你的旅行需求", flow: 0 },
  FETCHING_DATA: { label: "信息搜集", eyebrow: "STAGE 2 / RESEARCH", title: "AI 正在搜集与核验旅行信息", flow: 1 },
  ASSESSING_EVIDENCE: { label: "信息搜集", eyebrow: "STAGE 2 / RESEARCH", title: "正在评估信息可信度", flow: 1 },
  GENERATING_ITINERARY: { label: "智能规划", eyebrow: "STAGE 3 / PLAN", title: "AI 正在计算三套差异路线", flow: 2 },
  VALIDATING_ITINERARY: { label: "方案呈现", eyebrow: "STAGE 4 / PRESENT", title: "三套路线已准备好", flow: 3 },
  ANALYZING_UNCERTAINTY: { label: "方案呈现", eyebrow: "STAGE 4 / PRESENT", title: "正在识别出发前待确认项", flow: 3 },
  ANALYZING_FRAGILITY: { label: "方案呈现", eyebrow: "STAGE 4 / PRESENT", title: "正在检查行程稳定性", flow: 3 },
  STRESS_TESTING: { label: "方案呈现", eyebrow: "STAGE 4 / PRESENT", title: "正在进行情景压力测试", flow: 3 },
  READY: { label: "方案呈现", eyebrow: "STAGE 4 / PRESENT", title: "可执行行程与决策依据", flow: 4 },
  EXECUTING: { label: "行程执行中", eyebrow: "EXECUTION MODE", title: "AI 正在管理当前旅行节点", flow: 4 },
  REPLANNING: { label: "局部重规划", eyebrow: "CHANGE PREVIEW", title: "正在计算最小扰动调整", flow: 4 },
  FINISHED: { label: "旅行已结束", eyebrow: "TRIP COMPLETE", title: "旅行执行已完成", flow: 4 },
  ERROR: { label: "需要重试", eyebrow: "AGENT PAUSED", title: "规划任务未完成", flow: -1 },
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  if (to === "ERROR" || from === "ERROR" || to === "EMPTY") return true;
  const order: AgentState[] = ["EMPTY", "COLLECTING_REQUIREMENTS", "BUILDING_PROFILE", "FETCHING_DATA", "ASSESSING_EVIDENCE", "GENERATING_ITINERARY", "VALIDATING_ITINERARY", "ANALYZING_UNCERTAINTY", "ANALYZING_FRAGILITY", "STRESS_TESTING", "READY", "EXECUTING", "REPLANNING", "FINISHED"];
  return Math.abs(order.indexOf(to) - order.indexOf(from)) <= 3 || from === "REPLANNING" && to === "READY";
}
