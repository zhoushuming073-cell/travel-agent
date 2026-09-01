import test from "node:test";
import assert from "node:assert/strict";
import { validatePlanContract, type PlanningEnvelope } from "../worker/domain/contract.ts";
import type { ItineraryPlan, TravelProfile } from "../worker/domain/types.ts";

const profile: TravelProfile = {
  city: "杭州",
  startDate: "2026-10-03",
  days: 4,
  preferences: ["自然", "摄影"],
  requiredAttractions: ["西湖", "灵隐寺"],
};

function plan(id: string): ItineraryPlan {
  const daysPlan = Array.from({ length: 4 }, (_, index) => ({
    day: index + 1,
    date: `2026-10-0${index + 3}`,
    items: index === 0
      ? [{ id: "west-lake", name: "西湖", requiredByUser: true }]
      : index === 1
        ? [{ id: "lingyin", name: "灵隐寺", requiredByUser: true }]
        : [{ id: `spot-${index}`, name: `候选景点 ${index}` }],
    blocks: [],
  }));
  return {
    id,
    variant: id,
    title: id,
    city: "杭州",
    startDate: profile.startDate,
    days: 4,
    generatedAt: "2026-08-21T00:00:00.000Z",
    daysPlan,
    travelFacts: [{
      id: `fact-${id}`,
      subject: "西湖",
      field: "开放时间",
      value: "全天",
      status: "estimated",
      sourceType: "public-poi",
      sourceName: "公开地图",
      sourceUrl: null,
      updatedAt: "2026-08-21T00:00:00.000Z",
      confidence: 0.7,
      importance: "high",
      uncertaintyReason: null,
      downstreamImpact: "影响必选节点",
    }],
    evidenceGraph: {
      nodes: [{ id: `source-${id}`, kind: "source", label: "公开地图", quality: "estimated", url: null }],
      edges: [],
      sourceCount: 1,
      factCount: 1,
      itineraryNodeCount: 1,
    },
    uncertainty: { count: 0, importantCount: 0, items: [], criticalUnknown: null },
    minimumVerification: [],
    compiler: {
      version: "2.0",
      reliability: 78,
      informationCompleteness: 70,
      minBufferMinutes: 30,
      constraintScore: 100,
      timeRisk: "low",
      weatherRisk: "unknown",
      crowdRisk: "unknown",
      reservationRisk: "medium",
      status: "可执行，但需完成关键核验",
      note: "测试契约",
      issues: [],
      checks: { requiredCoverage: true, dayCount: true, chronology: true, openingConflicts: 0, routeContinuity: true },
    },
    dependencyGraph: {
      nodes: [{ id: `${id}-start`, day: 1, kind: "day-start", label: "开始", durationMin: 0, startMinute: 540, endMinute: 540, fixed: true, required: false, hasAlternative: false }],
      edges: [],
    },
    criticalPath: { nodeIds: [`${id}-start`], totalMinutes: 0, nodes: [{ id: `${id}-start`, name: "开始", reason: "日程起点" }], note: "测试" },
    bufferAnalysis: { minBufferMinutes: 30, averageBufferMinutes: 30, criticalDay: 1, daily: [{ day: 1, explicitBufferMinutes: 30, endSlackMinutes: 0, effectiveBufferMinutes: 30 }] },
    fragility: { score: 35, level: "low", fixedNodeCount: 2, dependencyCount: 1, singlePointFailureCount: 0, minBufferMinutes: 30, alternativesAvailable: 4, vulnerableNodes: [], note: "测试" },
    stressTest: { type: "simulation", label: "情景模拟（不是实时预测）", scenarios: [], resilientCount: 0, repairableCount: 0 },
    changeScope: null,
  };
}

function envelope(): PlanningEnvelope {
  return {
    request: profile,
    alternatives: [plan("hot"), plan("niche"), plan("relax")],
    activeId: "relax",
    generatedAt: "2026-08-21T00:00:00.000Z",
  };
}

test("API contract accepts three evidence-backed alternatives with all required attractions", () => {
  assert.deepEqual(validatePlanContract(envelope()), []);
});

test("API contract rejects a plan that drops a required attraction", () => {
  const value = envelope();
  value.alternatives[1].daysPlan[1].items = [];
  assert.match(validatePlanContract(value).map((item) => item.message).join(" "), /灵隐寺/);
});

test("API contract rejects stress results that are not explicitly simulations", () => {
  const value = envelope();
  value.alternatives[0].stressTest = undefined;
  assert.match(validatePlanContract(value).map((item) => item.message).join(" "), /Simulation/);
});

test("API contract requires the stable hot, niche and relax variant IDs", () => {
  const value = envelope();
  value.alternatives[1].id = "custom";
  assert.match(validatePlanContract(value).map((item) => item.message).join(" "), /hot、niche、relax/);
});
