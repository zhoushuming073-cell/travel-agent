export interface WorkflowNode {
  id: string;
  layer: "fact" | "constraint" | "optimization" | "llm" | "compile";
  dependsOn: string[];
  execution: "parallel" | "serial" | "conditional";
}

export const PLANNING_WORKFLOW_DAG: WorkflowNode[] = [
  { id: "parse_profile", layer: "constraint", dependsOn: [], execution: "serial" },
  { id: "collect_candidates", layer: "fact", dependsOn: ["parse_profile"], execution: "parallel" },
  { id: "collect_weather", layer: "fact", dependsOn: ["parse_profile"], execution: "parallel" },
  { id: "collect_hotels", layer: "fact", dependsOn: ["parse_profile"], execution: "parallel" },
  { id: "entity_resolution", layer: "fact", dependsOn: ["collect_candidates"], execution: "serial" },
  { id: "build_fact_graph", layer: "fact", dependsOn: ["entity_resolution", "collect_weather", "collect_hotels"], execution: "serial" },
  { id: "active_research", layer: "fact", dependsOn: ["build_fact_graph"], execution: "conditional" },
  { id: "feasibility_precheck", layer: "constraint", dependsOn: ["build_fact_graph"], execution: "serial" },
  { id: "build_sparse_transit", layer: "fact", dependsOn: ["entity_resolution"], execution: "parallel" },
  { id: "optimize_variants", layer: "optimization", dependsOn: ["active_research", "feasibility_precheck", "build_sparse_transit"], execution: "serial" },
  { id: "semantic_critic", layer: "llm", dependsOn: ["optimize_variants"], execution: "conditional" },
  { id: "deterministic_repair", layer: "compile", dependsOn: ["optimize_variants"], execution: "serial" },
  { id: "semantic_repair", layer: "llm", dependsOn: ["semantic_critic", "deterministic_repair"], execution: "conditional" },
  { id: "verify_critical_transit", layer: "fact", dependsOn: ["deterministic_repair", "semantic_repair"], execution: "parallel" },
  { id: "micro_repair", layer: "compile", dependsOn: ["verify_critical_transit"], execution: "conditional" },
  { id: "cost_robustness_trust", layer: "compile", dependsOn: ["micro_repair"], execution: "parallel" },
  { id: "contract_validation", layer: "compile", dependsOn: ["cost_robustness_trust"], execution: "serial" },
];

export function workflowExecutionGroups(nodes = PLANNING_WORKFLOW_DAG) {
  const completed = new Set<string>();
  const remaining = new Map(nodes.map((node) => [node.id, node]));
  const groups: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((node) => node.dependsOn.every((dependency) => completed.has(dependency)));
    if (!ready.length) throw new Error("规划工作流 DAG 存在循环依赖");
    const group = ready.map((node) => node.id);
    groups.push(group);
    group.forEach((id) => { completed.add(id); remaining.delete(id); });
  }
  return groups;
}
