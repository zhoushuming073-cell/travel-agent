export type TravelFactStatus =
  | "verified"
  | "estimated"
  | "predicted"
  | "unknown"
  | "conflicting"
  | "stale";

export type EvidenceQuality = TravelFactStatus | "simulation";
export type ImportanceLevel = "high" | "medium" | "low";
export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface TravelProfile {
  city: string;
  startDate: string;
  days: number;
  nights?: number;
  partySize?: number;
  budget?: number;
  style?: string;
  preferences: string[];
  avoid?: string[];
  requiredAttractions: string[];
  excludedAttractions?: string[];
  adults?: number;
  children?: number;
  seniors?: number;
  budgetLevel?: string;
  interestPriorities?: Array<{ name?: string; priority?: string | number }>;
  crowdSensitivity?: string;
  weatherSensitivity?: string;
  walkingSensitivity?: string;
  seasonalNeeds?: string[];
  unknownFields?: string[];
  returnTime?: string;
  extractionModel?: string;
  extractionFormatRepaired?: boolean;
  fieldSources?: Record<string, "text-rule" | "ai-text" | "parameter" | "calculated" | "default">;
  pace?: string;
  transport?: string;
  deepReasoning?: boolean;
  hotelPreference?: string;
  lodgingArea?: string;
  dayStart?: string;
  dayEnd?: string;
  mealPreference?: string;
  requestedVariants?: string[];
  freeText?: string;
}

export interface FactSource {
  id: string;
  name: string;
  type: string;
  url: string | null;
  fetchedAt: string;
  quality: EvidenceQuality;
}

export interface FactObservation {
  value: unknown;
  source: FactSource;
  confidence: number;
}

export interface TravelFact {
  id: string;
  subject: string;
  field: string;
  value: unknown;
  status: TravelFactStatus;
  sourceType: string;
  sourceName: string;
  sourceUrl: string | null;
  updatedAt: string;
  observedAt?: string | null;
  fetchedAt?: string;
  expiresAt?: string;
  nature?: "observation" | "forecast" | "prediction" | "public-reference" | "unknown";
  confidence: number;
  importance: ImportanceLevel;
  uncertaintyReason: string | null;
  downstreamImpact: string;
  observations?: FactObservation[];
  ttlMs?: number;
}

export type EvidenceNode =
  | { id: string; kind: "source"; label: string; quality: EvidenceQuality; url: string | null }
  | { id: string; kind: "fact"; label: string; quality: EvidenceQuality; factId: string }
  | { id: string; kind: "itinerary"; label: string; quality: EvidenceQuality; itineraryNodeId: string };

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  relation: "supports" | "conflicts-with" | "informs";
}

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  sourceCount: number;
  factCount: number;
  itineraryNodeCount: number;
}

export interface UnknownItem {
  factId: string;
  subject: string;
  field: string;
  status: Extract<TravelFactStatus, "unknown" | "conflicting" | "stale">;
  score: number;
  importance: ImportanceLevel;
  reason: string;
  impact: string;
  hasAlternative: boolean;
  factors: {
    userConstraint: number;
    executionImpact: number;
    timeSensitivity: number;
    evidenceRisk: number;
    alternativePenalty: number;
  };
}

export interface UnknownAnalysis {
  count: number;
  importantCount: number;
  items: UnknownItem[];
  criticalUnknown: UnknownItem | null;
}

export interface VerificationItem {
  rank: number;
  factId: string;
  subject: string;
  field: string;
  reason: string;
  impact: string;
  action: string;
  priorityScore: number;
  cumulativeRiskCoverage: number;
}

export interface ItinerarySpot {
  id: string;
  name: string;
  officialName?: string;
  lat?: number;
  lng?: number;
  category?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  openingHours?: string | null;
  sourceName?: string;
  sourceUrl?: string | null;
  website?: string | null;
  fetchedAt?: string;
  requiredByUser?: boolean;
  reservation?: {
    relevant?: boolean;
    status?: string;
    note?: string;
  };
  officialVerification?: {
    officialSiteUrl?: string | null;
    openingSearchUrl?: string;
    reservationSearchUrl?: string;
    openingNature: "map-rule" | "official" | "unknown";
    reservationAvailability: "unknown" | "verified";
    note: string;
  };
  crowd?: {
    score?: number;
    label?: string;
    source?: string;
    confidence?: number;
    updatedAt?: string;
    riskProbability?: number;
    uncertainty?: "low" | "medium" | "high";
    factors?: string[];
    factorContributions?: Array<{
      id: string;
      label: string;
      impact: number;
      direction: "up" | "down" | "neutral";
      evidence: string;
      nature: "calendar" | "place-prior" | "forecast" | "public-trend" | "map-signal";
    }>;
    forecastBand?: { low: number; high: number };
    confidenceLabel?: "较高" | "中等" | "较低";
    evidenceCoverage?: number;
    freshnessHours?: number | null;
    modelVersion?: string;
    nature?: "prediction";
    officialRealtime?: false;
    crowdRole?: "nightscape" | "meal-landmark" | "timed-indoor" | "religious" | "theme-park" | "broad-outdoor" | "heritage-core" | "flexible";
    baseWeatherRainProbability?: number | null;
    recommendedWindow?: string;
    recommendedWindows?: string[];
    avoidWindow?: string;
    peakWindow?: string;
    action?: string;
    visitTime?: string;
    visitDate?: string;
    baseDate?: string;
    timeWindows?: Array<{ time: string; score: number; label: string; delta?: number }>;
  } | null;
  openingStatus?: {
    status?: "verified" | "estimated" | "unknown" | "conflicting";
    label?: string;
    alert?: string | null;
    sourceUrl?: string | null;
    updatedAt?: string;
  } | null;
  hotness?: {
    score?: number | null;
    label?: string;
    status?: TravelFactStatus;
    confidence?: number;
    updatedAt?: string;
    source?: string;
    sourceUrl?: string | null;
  } | null;
  seasonality?: {
    score?: number | null;
    state?: "OFF" | "PRE_SEASON" | "GOOD" | "PEAK" | "POST_PEAK" | "RECENT_SIGNAL" | "FORWARD_REFERENCE" | "UNKNOWN";
    label?: string;
    status?: TravelFactStatus;
    confidence?: number;
    updatedAt?: string;
    source?: string;
    sourceUrl?: string | null;
  } | null;
  factObservations?: Partial<Record<"openingHours" | "reservation" | "crowd" | "hotness" | "seasonality", FactObservation[]>>;
}

export interface TransitEvidence {
  durationMin?: number;
  source?: string;
  fetchedAt?: string;
}

export interface ItineraryBlock {
  type: "attraction" | "leg" | "rest";
  item?: ItinerarySpot;
  from?: string;
  to?: string;
  label?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  distanceM?: number;
  source?: string;
  quality?: EvidenceQuality | "routed" | "exact" | "forecast" | "unavailable";
  mealType?: string;
  mcpTransport?: TransitEvidence;
  mcpStatus?: { note?: string };
  mode?: string;
  fetchedAt?: string;
  reason?: string;
}

export interface WeatherDay {
  date: string;
  quality?: "forecast" | "unavailable" | EvidenceQuality;
  weatherCode?: number;
  temperatureMin?: number;
  temperatureMax?: number;
  precipitationProbability?: number;
  note?: string;
  fetchedAt?: string;
}

export interface ItineraryDay {
  day: number;
  date: string;
  theme?: string;
  items: ItinerarySpot[];
  blocks: ItineraryBlock[];
  weather?: WeatherDay;
  route?: {
    distance?: number;
    duration?: number;
    quality?: "routed" | "exact" | "estimated";
    source?: string;
    fetchedAt?: string;
  };
}

export interface CandidatePoolItem {
  id: string;
  name: string;
  selected: boolean;
  requiredByUser?: boolean;
}

export interface PlanEvaluation {
  overall?: number;
  constraintSatisfaction?: number;
  evidence?: {
    candidateCount?: number;
    selectedCount?: number;
    transportMinutes?: number;
    longestLegMinutes?: number;
    requiredMatched?: string[];
    requiredTotal?: number;
  };
}

export interface ItineraryPlan {
  id: string;
  variant: string;
  title: string;
  strategy?: string;
  city: string;
  startDate: string;
  days: number;
  generatedAt: string;
  daysPlan: ItineraryDay[];
  evaluation?: PlanEvaluation;
  candidatePool?: CandidatePoolItem[];
  weather?: { source?: string; fetchedAt?: string };
  hotelPlan?: {
    candidates?: Array<{
      name?: string;
      price?: number | null;
      source?: string;
      sourceUrl?: string | null;
      fetchedAt?: string;
    }>;
  };
  changeScope?: {
    mode?: string;
    affectedDays?: number[];
    preservedDays?: number[];
    note?: string;
  } | null;
  travelFacts?: TravelFact[];
  evidenceGraph?: EvidenceGraph;
  uncertainty?: UnknownAnalysis;
  minimumVerification?: VerificationItem[];
  compiler?: CompilerResult;
  dependencyGraph?: DependencyGraph;
  criticalPath?: CriticalPath;
  bufferAnalysis?: BufferAnalysis;
  fragility?: FragilityResult;
  stressTest?: StressResult;
  changeSet?: ChangeSet | null;
  planningDecision?: {
    model?: string;
    repairModel?: string;
    repairRounds?: number;
    formatRepairs?: number;
    networkToolCalls?: unknown[];
    degraded?: boolean;
    degradationReason?: string | null;
    draftCompilerIssues?: CompilerIssue[];
  };
}

export interface DependencyNode {
  id: string;
  day: number;
  kind: "day-start" | "attraction" | "leg" | "rest" | "day-end";
  label: string;
  durationMin: number;
  startMinute: number;
  endMinute: number;
  fixed: boolean;
  required: boolean;
  hasAlternative: boolean;
}

export interface DependencyEdge {
  id: string;
  from: string;
  to: string;
  relation: "sequence" | "travel" | "hard-constraint";
  lagMinutes: number;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface CriticalPath {
  nodeIds: string[];
  totalMinutes: number;
  nodes: Array<{ id: string; name: string; reason: string }>;
  note: string;
}

export interface BufferAnalysis {
  minBufferMinutes: number;
  averageBufferMinutes: number;
  criticalDay: number | null;
  daily: Array<{
    day: number;
    explicitBufferMinutes: number;
    endSlackMinutes: number;
    effectiveBufferMinutes: number;
  }>;
}

export interface CompilerIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  nodeId?: string;
}

export interface CompilerResult {
  version: "2.0";
  reliability: number;
  informationCompleteness: number;
  minBufferMinutes: number;
  constraintScore: number;
  timeRisk: RiskLevel;
  weatherRisk: RiskLevel;
  crowdRisk: RiskLevel | "predicted";
  reservationRisk: RiskLevel;
  status: string;
  note: string;
  issues: CompilerIssue[];
  checks: {
    requiredCoverage: boolean;
    dayCount: boolean;
    chronology: boolean;
    openingConflicts: number;
    routeContinuity: boolean;
  };
}

export interface FragilityResult {
  score: number;
  level: Exclude<RiskLevel, "unknown">;
  fixedNodeCount: number;
  dependencyCount: number;
  singlePointFailureCount: number;
  minBufferMinutes: number;
  alternativesAvailable: number;
  vulnerableNodes: Array<{ nodeId: string; label: string; reasons: string[]; score: number }>;
  note: string;
}

export interface StressScenario {
  id: "late-start" | "queue-delay" | "transit-delay" | "rain" | "closure" | "fatigue";
  name: string;
  type: "simulation";
  targetNodeId: string | null;
  delayMinutes: number;
  basis: string;
}

export interface StressScenarioResult extends StressScenario {
  outcome: "resilient" | "repairable" | "fragile";
  affectedNodeIds: string[];
  overflowMinutes: number;
  propagatedDelayMinutes: number;
  suggestedRepair: string;
}

export interface StressResult {
  type: "simulation";
  label: string;
  scenarios: StressScenarioResult[];
  resilientCount: number;
  repairableCount: number;
}

export interface ChangeItem {
  nodeId: string;
  day: number;
  label: string;
  kind: "added" | "removed" | "moved" | "time-changed";
  before?: string;
  after?: string;
}

export interface ChangeSet {
  mode: "minimum-disruption" | "global-with-preservation-guidance";
  affectedDays: number[];
  preservedDays: number[];
  added: ChangeItem[];
  removed: ChangeItem[];
  moved: ChangeItem[];
  timeChanged: ChangeItem[];
  unchangedNodeCount: number;
  changedNodeCount: number;
}

export interface ReplanningResult {
  proposedPlan: ItineraryPlan;
  changeSet: ChangeSet;
  requiresConfirmation: true;
}

export interface ExecutionFeedback {
  itineraryVersionId: string;
  nodeId?: string;
  type: "completed" | "skipped" | "delayed" | "rating" | "note";
  value: string | number | boolean;
  createdAt: string;
}

export type AgentState =
  | "EMPTY"
  | "COLLECTING_REQUIREMENTS"
  | "BUILDING_PROFILE"
  | "FETCHING_DATA"
  | "ASSESSING_EVIDENCE"
  | "GENERATING_ITINERARY"
  | "VALIDATING_ITINERARY"
  | "ANALYZING_UNCERTAINTY"
  | "ANALYZING_FRAGILITY"
  | "STRESS_TESTING"
  | "READY"
  | "EXECUTING"
  | "REPLANNING"
  | "FINISHED"
  | "ERROR";

export interface AgentEvent {
  id: string;
  workspaceId: string;
  type: string;
  state: AgentState;
  title: string;
  detail?: string;
  createdAt: string;
  evidenceIds?: string[];
  progress?: number;
}

export interface ItineraryVersion {
  id: string;
  workspaceId: string;
  version: number;
  parentVersionId: string | null;
  plan: ItineraryPlan;
  changeSet: ChangeSet | null;
  createdAt: string;
  createdBy: "agent" | "user";
  summary: string;
}

export interface TravelWorkspace {
  id: string;
  title: string;
  state: AgentState;
  profile: TravelProfile | null;
  alternatives: ItineraryPlan[];
  activePlanId: string | null;
  versions: ItineraryVersion[];
  events: AgentEvent[];
  pendingChange: ReplanningResult | null;
  executionFeedback: ExecutionFeedback[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRepository {
  list(): Promise<TravelWorkspace[]>;
  get(id: string): Promise<TravelWorkspace | null>;
  save(workspace: TravelWorkspace): Promise<void>;
  remove(id: string): Promise<void>;
}
