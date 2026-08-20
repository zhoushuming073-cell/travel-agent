import type { AgentState } from "../types.ts";

export const WORKSPACE_STAGES: Record<AgentState, { label: string; eyebrow: string; title: string; flow: number }> = {
  EMPTY: { label: "等待输入", eyebrow: "NEW TRIP", title: "开始一段新旅行", flow: -1 },
  COLLECTING_REQUIREMENTS: { label: "补充需求", eyebrow: "REQUIREMENTS", title: "正在补充旅行需求", flow: 0 },
  BUILDING_PROFILE: { label: "整理需求", eyebrow: "STAGE 1 / PROFILE", title: "AI 正在理解你的旅行需求", flow: 0 },
  FETCHING_DATA: { label: "联网取证", eyebrow: "STAGE 2 / EVIDENCE", title: "AI 正在搜集资料并规划行程", flow: 1 },
  ASSESSING_EVIDENCE: { label: "评估证据", eyebrow: "STAGE 2 / EVIDENCE", title: "正在评估信息可信度", flow: 1 },
  GENERATING_ITINERARY: { label: "生成路线", eyebrow: "STAGE 3 / ROUTING", title: "正在生成三套候选方案", flow: 2 },
  VALIDATING_ITINERARY: { label: "行程校验", eyebrow: "STAGE 4 / VALIDATION", title: "AI 正在生成并校验你的行程", flow: 3 },
  ANALYZING_UNCERTAINTY: { label: "分析未知", eyebrow: "STAGE 4 / VALIDATION", title: "正在识别关键未知与最低核验项", flow: 3 },
  ANALYZING_FRAGILITY: { label: "分析脆弱性", eyebrow: "STAGE 4 / VALIDATION", title: "正在计算关键路径与脆弱节点", flow: 3 },
  STRESS_TESTING: { label: "情景压测", eyebrow: "STAGE 4 / VALIDATION", title: "正在进行节点级情景模拟", flow: 3 },
  READY: { label: "规划完成", eyebrow: "TRAVEL WORKSPACE", title: "可执行行程与决策依据", flow: 4 },
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

