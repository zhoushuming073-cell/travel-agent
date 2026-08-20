import type {
  AgentEvent,
  AgentState,
  ChangeSet,
  ItineraryDay,
  ItineraryPlan,
  TravelProfile,
  TravelWorkspace,
} from "../worker/domain/types.ts";

export type { AgentEvent, AgentState, ChangeSet, TravelProfile, TravelWorkspace };

export interface UiRouteGeometry {
  coordinates?: [number, number][];
}

export interface UiHotelCandidate {
  name?: string;
  address?: string;
  price?: number | null;
  priceType?: string;
  source?: string;
  sourceUrl?: string | null;
  rating?: string;
}

export type UiPlan = Omit<ItineraryPlan, "hotelPlan" | "daysPlan"> & {
  budget?: number;
  pace?: string;
  transport?: string;
  strategy?: string;
  hotelPlan?: {
    name?: string;
    reason?: string;
    note?: string;
    mcpStatus?: string;
    pricedCount?: number;
    candidates?: UiHotelCandidate[];
  };
  budgetBreakdown?: {
    knownEstimate?: number;
    limit?: number;
    note?: string;
    items?: Array<{ name: string; amount: number | null }>;
  };
  daysPlan: Array<Omit<ItineraryDay, "route"> & {
    route?: ItineraryDay["route"] & { geometry?: UiRouteGeometry };
  }>;
};

export interface PlanningProgress {
  phase: "analysis" | "live" | "route" | "queued";
  title: string;
  items: string[];
  formSync?: TravelProfile;
}

export interface PlanningResult {
  request: TravelProfile;
  alternatives: UiPlan[];
  activeId: string;
  generatedAt: string;
  alternativeComparison?: Array<Record<string, string | number | null | undefined>>;
  agentEvents?: AgentEvent[];
  progress?: PlanningProgress;
}

export interface PendingChange {
  before: UiPlan;
  after: UiPlan;
  result: PlanningResult;
  adjustment: string;
  changeSet: ChangeSet | null;
}

export interface WorkspaceSnapshot extends Omit<TravelWorkspace, "alternatives" | "pendingChange"> {
  alternatives: UiPlan[];
  pendingChange: null;
}

export interface ComposerMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface TravelFormState {
  city: string;
  startDate: string;
  days: number;
  budget: number;
  partySize: number;
  style: string;
  preferences: string[];
  pace: string;
  transport: string;
  hotelPreference: string;
}
