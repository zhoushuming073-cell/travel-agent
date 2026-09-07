import { compileItinerary } from "./compiler.ts";
import { analyzeBuffers, buildDependencyGraph, calculateCriticalPath } from "./dependency.ts";
import { buildEvidenceGraph } from "./evidence.ts";
import { buildTravelFacts } from "./facts.ts";
import { buildPlanningFactGraph } from "./fact-graph.ts";
import { analyzeFragility } from "./risk.ts";
import { stableHash } from "./reproducibility.ts";
import { simulatePlanRobustness } from "./robustness.ts";
import { runStressTest } from "./stress.ts";
import { analyzeUnknowns, buildMinimumVerification } from "./unknown.ts";
import type {
  BufferAnalysis,
  CompilerResult,
  CriticalPath,
  DependencyGraph,
  EvidenceGraph,
  PlanningFactGraph,
  FragilityResult,
  ItineraryPlan,
  StressResult,
  RobustnessSimulation,
  TravelFact,
  TravelProfile,
  UnknownAnalysis,
  VerificationItem,
} from "./types.ts";

export interface PlanTrustAnalysis {
  travelFacts: TravelFact[];
  evidenceGraph: EvidenceGraph;
  factGraph: PlanningFactGraph;
  uncertainty: UnknownAnalysis;
  minimumVerification: VerificationItem[];
  dependencyGraph: DependencyGraph;
  criticalPath: CriticalPath;
  bufferAnalysis: BufferAnalysis;
  compiler: CompilerResult;
  fragility: FragilityResult;
  stressTest: StressResult;
  robustnessSimulation: RobustnessSimulation;
}

export function analyzePlanTrustV2(plan: ItineraryPlan, profile: TravelProfile, now = new Date()): PlanTrustAnalysis {
  const travelFacts = buildTravelFacts(plan, profile, now);
  const evidenceGraph = buildEvidenceGraph(plan, travelFacts);
  const factGraph = buildPlanningFactGraph(plan, travelFacts, now.toISOString());
  const uncertainty = analyzeUnknowns(plan, travelFacts, now);
  const minimumVerification = buildMinimumVerification(uncertainty, travelFacts);
  const dependencyGraph = buildDependencyGraph(plan, profile);
  const bufferAnalysis = analyzeBuffers(plan, profile);
  const criticalPath = calculateCriticalPath(dependencyGraph);
  const compiler = compileItinerary(plan, profile, travelFacts, dependencyGraph, bufferAnalysis, uncertainty);
  const fragility = analyzeFragility(plan, dependencyGraph, bufferAnalysis, uncertainty);
  const stressTest = runStressTest(dependencyGraph, bufferAnalysis);
  const seed = Number.parseInt(stableHash({ id: plan.id, city: plan.city, startDate: plan.startDate, facts: travelFacts.map((fact) => fact.id) }), 16) >>> 0;
  const robustnessSimulation = simulatePlanRobustness(dependencyGraph, bufferAnalysis, uncertainty, seed);
  return {
    travelFacts,
    evidenceGraph,
    factGraph,
    uncertainty,
    minimumVerification,
    dependencyGraph,
    criticalPath,
    bufferAnalysis,
    compiler,
    fragility,
    stressTest,
    robustnessSimulation,
  };
}
