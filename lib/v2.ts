// Lattice V2 — Organizational State Graph types + helpers.
// V2 layers on top of V1 (field_objects, memory, requests, reminders).
// It adds first-class goals, change_events, assumptions, dependencies,
// confidence_signals, and interventions.

import type {
  DelegatedRequest,
  FieldObject,
  FieldObjectType,
  MemoryEvent,
  Reminder,
  RequestState,
  TeamState,
} from "@/lib/lattice";

export type GoalState = "active" | "paused" | "achieved" | "dropped" | "superseded";

export type AssumptionState = "holds" | "at_risk" | "invalidated" | "reconfirmed";

export type InterventionState = "suggested" | "accepted" | "dismissed" | "acted";

export type ChangeKind =
  | "goal_shift"
  | "scope_change"
  | "priority_change"
  | "deadline_move"
  | "owner_change"
  | "blocker_emerged"
  | "blocker_resolved"
  | "assumption_invalidated"
  | "confidence_change"
  | "commitment_added"
  | "commitment_completed"
  | "commitment_stale";

export type Goal = {
  id: string;
  title: string;
  detail?: string;
  state: GoalState;
  priority: number;
  confidence: number;
  previousGoalId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ChangeEvent = {
  id: string;
  kind: ChangeKind;
  summary: string;
  detail?: string;
  targetId?: string;
  targetType?: string;
  previousValue?: unknown;
  newValue?: unknown;
  source?: string;
  impact?: { teamReadable?: string; affects?: string[] };
  createdAt: string;
};

export type Assumption = {
  id: string;
  statement: string;
  state: AssumptionState;
  tiedTo?: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Dependency = {
  id: string;
  sourceId: string;
  targetKind: string;
  targetRef: string;
  note?: string;
  resolvedAt?: string;
  createdAt: string;
};

export type ConfidenceSignal = {
  id: string;
  targetId: string;
  targetType: string;
  confidence: number;
  note?: string;
  createdAt: string;
};

export type Intervention = {
  id: string;
  title: string;
  rationale: string;
  actionKind: string;
  urgency: number;
  targetId?: string;
  targetType?: string;
  state: InterventionState;
  createdAt: string;
  updatedAt: string;
};

// Full V2 state bundle = V1 TeamState + new graph nodes.
export type LatticeState = {
  // V1 surface (kept for continuity)
  intent: string;
  fieldObjects: FieldObject[];
  memory: MemoryEvent[];
  requests: DelegatedRequest[];
  reminders: Reminder[];
  tensions: string[];
  broadcast: string[];
  // V2 graph
  goals: Goal[];
  changeEvents: ChangeEvent[];
  assumptions: Assumption[];
  dependencies: Dependency[];
  confidenceSignals: ConfidenceSignal[];
  interventions: Intervention[];
};

export const emptyLatticeState: LatticeState = {
  intent: "",
  fieldObjects: [],
  memory: [],
  requests: [],
  reminders: [],
  tensions: [],
  broadcast: [],
  goals: [],
  changeEvents: [],
  assumptions: [],
  dependencies: [],
  confidenceSignals: [],
  interventions: [],
};

// ------------------------------------------------------------------
// Rich interpretation schema — V2 returns more than V1 entities:
// it also emits detected change events, new/updated goals, assumption
// transitions, and intervention candidates.
// ------------------------------------------------------------------

export type InterpretationEntityV2 = {
  type: FieldObjectType;
  title: string;
  detail: string;
  owner?: string;
  trigger?: string;
  target?: string;
  why?: string;
  linkedTo?: string;
  confidence?: number;
  dueAt?: string;
};

export type DetectedChangeEvent = {
  kind: ChangeKind;
  summary: string;
  detail?: string;
  targetType?: string;
  teamReadable?: string;
  affects?: string[];
};

export type DetectedGoalShift = {
  mode: "replace" | "adjust" | "new";
  title: string;
  detail?: string;
  previousGoalId?: string;
  confidence?: number;
};

export type DetectedAssumption = {
  statement: string;
  state?: AssumptionState;
  tiedTo?: string;
};

export type DetectedIntervention = {
  title: string;
  rationale: string;
  actionKind: string;
  urgency?: number;
  targetType?: string;
};

export type InterpretationV2 = {
  reply: string;
  richReply?: {
    headline: string;
    recorded: string[];
    implications: string[];
    suggested: string[];
  };
  entities: InterpretationEntityV2[];
  changes: DetectedChangeEvent[];
  goalShift?: DetectedGoalShift | null;
  assumptions?: DetectedAssumption[];
  interventions?: DetectedIntervention[];
  followUpQuestion?: string;
  broadcast?: string[];
  confidenceImpact?: {
    goalConfidence?: number;
    note?: string;
  };
};

export function labelForChangeKind(kind: ChangeKind): string {
  const map: Record<ChangeKind, string> = {
    goal_shift: "Goal shifted",
    scope_change: "Scope changed",
    priority_change: "Priority changed",
    deadline_move: "Deadline moved",
    owner_change: "Owner changed",
    blocker_emerged: "New blocker",
    blocker_resolved: "Blocker cleared",
    assumption_invalidated: "Assumption broke",
    confidence_change: "Confidence shifted",
    commitment_added: "New commitment",
    commitment_completed: "Commitment done",
    commitment_stale: "Commitment stale",
  };
  return map[kind];
}

export function glyphForChangeKind(kind: ChangeKind): string {
  const map: Record<ChangeKind, string> = {
    goal_shift: "⇄",
    scope_change: "◇",
    priority_change: "▲",
    deadline_move: "⏱",
    owner_change: "@",
    blocker_emerged: "✕",
    blocker_resolved: "✓",
    assumption_invalidated: "!",
    confidence_change: "∿",
    commitment_added: "+",
    commitment_completed: "●",
    commitment_stale: "∘",
  };
  return map[kind];
}

export function accentForChangeKind(kind: ChangeKind): string {
  const ink = [
    "goal_shift",
    "priority_change",
    "scope_change",
    "commitment_added",
  ];
  const warn = [
    "blocker_emerged",
    "assumption_invalidated",
    "commitment_stale",
    "deadline_move",
  ];
  const good = ["blocker_resolved", "commitment_completed"];
  if (good.includes(kind)) return "good";
  if (warn.includes(kind)) return "warn";
  if (ink.includes(kind)) return "shift";
  return "muted";
}

// Derive "what changed since..." for the pulse view.
export function whatChangedSince(state: LatticeState, isoCutoff: string) {
  const cutoff = Date.parse(isoCutoff);
  if (Number.isNaN(cutoff)) return state.changeEvents;
  return state.changeEvents.filter((c) => Date.parse(c.createdAt) >= cutoff);
}

// Goal drift: for each current commitment (promise), check whether it
// links (directly or via linked intents) to the current goal. Anything
// that does not is "drifting" and should be flagged.
export function goalDrift(state: LatticeState): {
  driftingCommitments: FieldObject[];
  alignedCount: number;
} {
  const activeGoal = state.goals.find((g) => g.state === "active");
  if (!activeGoal) {
    return { driftingCommitments: [], alignedCount: 0 };
  }
  const commitments = state.fieldObjects.filter((f) => f.type === "promise");
  const drift: FieldObject[] = [];
  let aligned = 0;
  const goalKeywords = activeGoal.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  for (const c of commitments) {
    const haystack = `${c.title} ${c.detail} ${c.status ?? ""}`.toLowerCase();
    const linksToIntent = (c.links ?? []).some((l) => l.startsWith("intent-"));
    const matchesKeyword = goalKeywords.some((k) => haystack.includes(k));
    if (linksToIntent || matchesKeyword) {
      aligned += 1;
    } else {
      drift.push(c);
    }
  }
  return { driftingCommitments: drift, alignedCount: aligned };
}

// Structural blocker analysis: count blockers per owner, detect recurring words.
export function structuralAnalysis(state: LatticeState) {
  const blockers = state.fieldObjects.filter((f) => f.type === "blocker");
  const ownerLoad = new Map<string, number>();
  const tokens = new Map<string, number>();
  for (const b of blockers) {
    const owner = b.owner ?? "Unassigned";
    ownerLoad.set(owner, (ownerLoad.get(owner) ?? 0) + 1);
    for (const word of b.title.toLowerCase().split(/\s+/)) {
      if (word.length < 4) continue;
      tokens.set(word, (tokens.get(word) ?? 0) + 1);
    }
  }
  const overloaded = [...ownerLoad.entries()]
    .filter(([, count]) => count >= 2)
    .map(([owner, count]) => ({ owner, count }));
  const recurring = [...tokens.entries()]
    .filter(([, count]) => count >= 2)
    .map(([token, count]) => ({ token, count }));
  return { overloaded, recurring, totalBlockers: blockers.length };
}

// Confidence snapshot for the team: weighted avg of goal confidence + commitments.
export function teamConfidence(state: LatticeState): number {
  const activeGoal = state.goals.find((g) => g.state === "active");
  const commitments = state.fieldObjects.filter((f) => f.type === "promise");
  if (!activeGoal && commitments.length === 0) return 0.7;
  const goalC = activeGoal?.confidence ?? 0.7;
  if (commitments.length === 0) return goalC;
  const commAvg = commitments.reduce((a, b) => a + b.confidence, 0) / commitments.length;
  return Number((goalC * 0.5 + commAvg * 0.5).toFixed(2));
}

// Count commitments at risk (confidence < 0.5 or blocker).
export function atRiskCount(state: LatticeState): number {
  const commitments = state.fieldObjects.filter((f) => f.type === "promise");
  const blocked = new Set<string>();
  for (const b of state.fieldObjects.filter((f) => f.type === "blocker")) {
    for (const link of b.links ?? []) blocked.add(link);
  }
  return commitments.filter((c) => c.confidence < 0.5 || blocked.has(c.id)).length;
}

export function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export type { FieldObject, FieldObjectType, MemoryEvent, DelegatedRequest, RequestState, Reminder, TeamState };
