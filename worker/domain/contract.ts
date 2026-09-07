import type { ItineraryPlan, TravelProfile } from "./types.ts";

const REQUIRED_VARIANT_IDS = new Set(["hot", "niche", "relax"]);

export interface PlanningEnvelope {
  request: TravelProfile;
  alternatives: ItineraryPlan[];
  activeId: string;
  generatedAt: string;
}

export interface ContractIssue {
  path: string;
  message: string;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[\s·・—_\-（）()]/g, "");
}

function includesRequired(plan: ItineraryPlan, requiredName: string): boolean {
  const expected = normalized(requiredName);
  return plan.daysPlan.some((day) => day.items.some((item) => {
    const actual = normalized(item.name);
    return actual.includes(expected) || expected.includes(actual);
  }));
}

export function validatePlanContract(value: PlanningEnvelope): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!Array.isArray(value.alternatives) || value.alternatives.length !== 3) {
    issues.push({ path: "alternatives", message: "必须返回正好三套候选方案" });
    return issues;
  }

  const ids = new Set<string>();
  value.alternatives.forEach((plan, planIndex) => {
    const base = `alternatives[${planIndex}]`;
    if (!plan.id || ids.has(plan.id)) issues.push({ path: `${base}.id`, message: "方案 ID 必须存在且唯一" });
    ids.add(plan.id);
    if (plan.daysPlan.length !== value.request.days) {
      issues.push({ path: `${base}.daysPlan`, message: "方案天数必须与用户需求一致" });
    }
    value.request.requiredAttractions.forEach((name) => {
      if (!includesRequired(plan, name)) {
        issues.push({ path: `${base}.daysPlan`, message: `缺少必选景点：${name}` });
      }
    });
    if (!plan.travelFacts?.length) issues.push({ path: `${base}.travelFacts`, message: "缺少 Travel Fact" });
    if (!plan.evidenceGraph?.nodes.length) issues.push({ path: `${base}.evidenceGraph`, message: "缺少 Evidence Graph" });
    if (!plan.compiler || plan.compiler.version !== "2.0") issues.push({ path: `${base}.compiler`, message: "缺少 Travel Compiler 2.0" });
    if (!plan.dependencyGraph?.nodes.length) issues.push({ path: `${base}.dependencyGraph`, message: "缺少 Dependency Graph" });
    if (!plan.criticalPath?.nodeIds.length) issues.push({ path: `${base}.criticalPath`, message: "缺少 Critical Path" });
    if (!plan.bufferAnalysis?.daily.length) issues.push({ path: `${base}.bufferAnalysis`, message: "缺少 Buffer Analysis" });
    if (!plan.uncertainty) issues.push({ path: `${base}.uncertainty`, message: "缺少 Unknown Analysis" });
    if (!Array.isArray(plan.minimumVerification)) issues.push({ path: `${base}.minimumVerification`, message: "缺少 Minimum Verification" });
    if (!plan.fragility) issues.push({ path: `${base}.fragility`, message: "缺少 Fragility" });
    if (plan.stressTest?.type !== "simulation") issues.push({ path: `${base}.stressTest`, message: "压力测试必须明确标注 Simulation" });
    if (plan.contractVersion === "3.0") {
      if (!plan.factGraph?.nodes.length) issues.push({ path: `${base}.factGraph`, message: "Contract 3.0 缺少版本化 Fact Graph" });
      if (plan.robustnessSimulation?.type !== "simulation") issues.push({ path: `${base}.robustnessSimulation`, message: "Contract 3.0 缺少 Monte Carlo 鲁棒性模拟" });
      if (!plan.reproducibility?.requestHash) issues.push({ path: `${base}.reproducibility`, message: "Contract 3.0 缺少可复现快照" });
      if (!plan.diversity) issues.push({ path: `${base}.diversity`, message: "Contract 3.0 缺少多维方案差异指标" });
      if (!plan.plannerVersion || !plan.scoringVersion || !plan.crowdModelVersion || !plan.costModelVersion) issues.push({ path: base, message: "Contract 3.0 缺少算法版本号" });
    }
    if (!("changeScope" in plan)) issues.push({ path: `${base}.changeScope`, message: "必须保留 Change Preview 兼容字段" });
  });

  const unexpectedIds = [...ids].filter((id) => !REQUIRED_VARIANT_IDS.has(id));
  const missingIds = [...REQUIRED_VARIANT_IDS].filter((id) => !ids.has(id));
  if (unexpectedIds.length || missingIds.length) {
    issues.push({ path: "alternatives", message: "方案 ID 必须正好是 hot、niche、relax" });
  }

  if (!ids.has(value.activeId)) issues.push({ path: "activeId", message: "activeId 必须指向候选方案" });
  return issues;
}

export function assertPlanContract(value: PlanningEnvelope): void {
  const issues = validatePlanContract(value);
  if (issues.length) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }
}
