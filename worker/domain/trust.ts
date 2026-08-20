import { compileItinerary } from "./compiler.ts";
import { analyzeBuffers, buildDependencyGraph, calculateCriticalPath } from "./dependency.ts";
import { buildEvidenceGraph } from "./evidence.ts";
import { buildTravelFacts } from "./facts.ts";
import { analyzeFragility } from "./risk.ts";
import { runStressTest } from "./stress.ts";
import { analyzeUnknowns, buildMinimumVerification } from "./unknown.ts";
import type {
  BufferAnalysis,
  CompilerResult,
  CriticalPath,
  DependencyGraph,
  EvidenceGraph,
  FragilityResult,
  ItineraryPlan,
  StressResult,
  TravelFact,
  TravelProfile,
  UnknownAnalysis,
  VerificationItem,
} from "./types.ts";

export interface PlanTrustAnalysis {
  travelFacts: TravelFact[];
  evidenceGraph: EvidenceGraph;
  uncertainty: UnknownAnalysis;
  minimumVerification: VerificationItem[];
  dependencyGraph: DependencyGraph;
  criticalPath: CriticalPath;
  bufferAnalysis: BufferAnalysis;
  compiler: CompilerResult;
  fragility: FragilityResult;
  stressTest: StressResult;
}

export function analyzePlanTrustV2(plan: ItineraryPlan, profile: TravelProfile, now = new Date()): PlanTrustAnalysis {
  const travelFacts = buildTravelFacts(plan, profile, now);
  const evidenceGraph = buildEvidenceGraph(plan, travelFacts);
  const uncertainty = analyzeUnknowns(plan, travelFacts, now);
  const minimumVerification = buildMinimumVerification(uncertainty, travelFacts);
  const dependencyGraph = buildDependencyGraph(plan, profile);
  const bufferAnalysis = analyzeBuffers(plan, profile);
  const criticalPath = calculateCriticalPath(dependencyGraph);
  const compiler = compileItinerary(plan, profile, travelFacts, dependencyGraph, bufferAnalysis, uncertainty);
  const fragility = analyzeFragility(plan, dependencyGraph, bufferAnalysis, uncertainty);
  const stressTest = runStressTest(dependencyGraph, bufferAnalysis);
  return {
    travelFacts,
    evidenceGraph,
    uncertainty,
    minimumVerification,
    dependencyGraph,
    criticalPath,
    bufferAnalysis,
    compiler,
    fragility,
    stressTest,
  };
}

