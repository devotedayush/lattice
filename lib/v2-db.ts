import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyInterpretation as applyV1,
  type FieldObjectType,
  type Interpretation as InterpretationV1,
  type MemoryEvent,
} from "@/lib/lattice";
import { fetchTeamState } from "@/lib/team-state-db";
import {
  type Assumption,
  type ChangeEvent,
  type ChangeKind,
  type ConfidenceSignal,
  type Dependency,
  type Goal,
  type GoalState,
  type Intervention,
  type InterpretationV2,
  type InterventionState,
  type LatticeState,
} from "@/lib/v2";

const DEFAULT_TEAM_SPACE_ID = process.env.LATTICE_TEAM_SPACE_ID ?? "demo-team-space";

type GoalRow = {
  id: string;
  title: string;
  detail: string | null;
  state: GoalState;
  priority: number;
  confidence: number | string;
  previous_goal_id: string | null;
  created_at: string;
  updated_at: string;
};

type ChangeEventRow = {
  id: string;
  kind: ChangeKind;
  summary: string;
  detail: string | null;
  target_id: string | null;
  target_type: string | null;
  previous_value: unknown;
  new_value: unknown;
  source: string | null;
  impact: { teamReadable?: string; affects?: string[] } | null;
  created_at: string;
};

type AssumptionRow = {
  id: string;
  statement: string;
  state: Assumption["state"];
  tied_to: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

type DependencyRow = {
  id: string;
  source_id: string;
  target_kind: string;
  target_ref: string;
  note: string | null;
  resolved_at: string | null;
  created_at: string;
};

type ConfidenceSignalRow = {
  id: string;
  target_id: string;
  target_type: string;
  confidence: number | string;
  note: string | null;
  created_at: string;
};

type InterventionRow = {
  id: string;
  title: string;
  rationale: string;
  action_kind: string;
  urgency: number;
  target_id: string | null;
  target_type: string | null;
  state: InterventionState;
  dismissed_at: string | null;
  acted_at: string | null;
  created_at: string;
  updated_at: string;
};

function toGoal(r: GoalRow): Goal {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail ?? undefined,
    state: r.state,
    priority: r.priority,
    confidence: Number(r.confidence),
    previousGoalId: r.previous_goal_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toChangeEvent(r: ChangeEventRow): ChangeEvent {
  return {
    id: r.id,
    kind: r.kind,
    summary: r.summary,
    detail: r.detail ?? undefined,
    targetId: r.target_id ?? undefined,
    targetType: r.target_type ?? undefined,
    previousValue: r.previous_value,
    newValue: r.new_value,
    source: r.source ?? undefined,
    impact: r.impact ?? undefined,
    createdAt: r.created_at,
  };
}

function toAssumption(r: AssumptionRow): Assumption {
  return {
    id: r.id,
    statement: r.statement,
    state: r.state,
    tiedTo: r.tied_to ?? undefined,
    lastCheckedAt: r.last_checked_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDependency(r: DependencyRow): Dependency {
  return {
    id: r.id,
    sourceId: r.source_id,
    targetKind: r.target_kind,
    targetRef: r.target_ref,
    note: r.note ?? undefined,
    resolvedAt: r.resolved_at ?? undefined,
    createdAt: r.created_at,
  };
}

function toConfidenceSignal(r: ConfidenceSignalRow): ConfidenceSignal {
  return {
    id: r.id,
    targetId: r.target_id,
    targetType: r.target_type,
    confidence: Number(r.confidence),
    note: r.note ?? undefined,
    createdAt: r.created_at,
  };
}

function toIntervention(r: InterventionRow): Intervention {
  return {
    id: r.id,
    title: r.title,
    rationale: r.rationale,
    actionKind: r.action_kind,
    urgency: r.urgency,
    targetId: r.target_id ?? undefined,
    targetType: r.target_type ?? undefined,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function fetchLatticeState(
  supabase: SupabaseClient,
  teamSpaceId = DEFAULT_TEAM_SPACE_ID,
): Promise<LatticeState> {
  const v1 = await fetchTeamState(teamSpaceId, supabase);

  const [goals, changes, assumptions, deps, signals, interventions] = await Promise.all([
    supabase
      .from("goals")
      .select("id, title, detail, state, priority, confidence, previous_goal_id, created_at, updated_at")
      .eq("team_space_id", teamSpaceId)
      .order("priority", { ascending: true }),
    supabase
      .from("change_events")
      .select("id, kind, summary, detail, target_id, target_type, previous_value, new_value, source, impact, created_at")
      .eq("team_space_id", teamSpaceId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("assumptions")
      .select("id, statement, state, tied_to, last_checked_at, created_at, updated_at")
      .eq("team_space_id", teamSpaceId)
      .order("created_at", { ascending: false }),
    supabase
      .from("dependencies")
      .select("id, source_id, target_kind, target_ref, note, resolved_at, created_at")
      .eq("team_space_id", teamSpaceId),
    supabase
      .from("confidence_signals")
      .select("id, target_id, target_type, confidence, note, created_at")
      .eq("team_space_id", teamSpaceId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("interventions")
      .select("id, title, rationale, action_kind, urgency, target_id, target_type, state, dismissed_at, acted_at, created_at, updated_at")
      .eq("team_space_id", teamSpaceId)
      .order("urgency", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);

  if (goals.error) throw goals.error;
  if (changes.error) throw changes.error;
  if (assumptions.error) throw assumptions.error;
  if (deps.error) throw deps.error;
  if (signals.error) throw signals.error;
  if (interventions.error) throw interventions.error;

  return {
    ...v1,
    goals: ((goals.data ?? []) as GoalRow[]).map(toGoal),
    changeEvents: ((changes.data ?? []) as ChangeEventRow[]).map(toChangeEvent),
    assumptions: ((assumptions.data ?? []) as AssumptionRow[]).map(toAssumption),
    dependencies: ((deps.data ?? []) as DependencyRow[]).map(toDependency),
    confidenceSignals: ((signals.data ?? []) as ConfidenceSignalRow[]).map(toConfidenceSignal),
    interventions: ((interventions.data ?? []) as InterventionRow[]).map(toIntervention),
  };
}

// Apply a V2 interpretation to the database:
//   1. Use V1 apply path for surface entities (field_objects / memory / etc.)
//   2. Persist new change_events
//   3. Goal shift → create new goal + supersede previous
//   4. New assumptions
//   5. New interventions
//   6. Confidence signal on goal if provided
export async function applyInterpretationV2ToDatabase(
  supabase: SupabaseClient,
  params: {
    input: string;
    interpretation: InterpretationV2;
    teamSpaceId?: string;
  },
): Promise<LatticeState> {
  const teamSpaceId = params.teamSpaceId ?? DEFAULT_TEAM_SPACE_ID;
  const { interpretation, input } = params;

  // --- 1. Apply V1 surface (field_objects / memory / requests / reminders / tensions / broadcast)
  // Reuse existing V1 path by shaping into its Interpretation type.
  const v1Interpretation: InterpretationV1 = {
    reply: interpretation.reply,
    entities: interpretation.entities.map((e) => ({
      type: e.type,
      title: e.title,
      detail: e.detail,
      owner: e.owner,
      trigger: e.trigger,
      target: e.target,
      why: e.why,
      linkedTo: e.linkedTo,
      dueAt: e.dueAt,
    })),
    followUpQuestion: interpretation.followUpQuestion,
    broadcast: interpretation.broadcast,
  };

  await applyV1ToDatabase(supabase, teamSpaceId, input, v1Interpretation);

  // --- 2. Record change events
  const now = Date.now();
  if (interpretation.changes?.length) {
    const rows = interpretation.changes.map((c, i) => ({
      id: `chg-${now}-${i}`,
      team_space_id: teamSpaceId,
      kind: c.kind,
      summary: c.summary,
      detail: c.detail ?? null,
      target_type: c.targetType ?? null,
      source: "interpretation",
      impact: c.teamReadable || c.affects
        ? { teamReadable: c.teamReadable, affects: c.affects }
        : null,
    }));
    const { error } = await supabase.from("change_events").insert(rows);
    if (error) throw error;
  }

  // --- 3. Goal shift
  if (interpretation.goalShift) {
    const shift = interpretation.goalShift;
    const { data: currentActive } = await supabase
      .from("goals")
      .select("id")
      .eq("team_space_id", teamSpaceId)
      .eq("state", "active")
      .limit(1)
      .maybeSingle();

    const newGoalId = `goal-${now}`;

    if (shift.mode === "replace" && currentActive) {
      await supabase.from("goals").update({ state: "superseded" }).eq("id", currentActive.id);
    }

    await supabase.from("goals").insert({
      id: newGoalId,
      team_space_id: teamSpaceId,
      title: shift.title,
      detail: shift.detail ?? null,
      state: "active",
      priority: 1,
      confidence: shift.confidence ?? 0.65,
      previous_goal_id: currentActive?.id ?? null,
    });

    if (shift.mode === "adjust" && currentActive) {
      await supabase.from("goals").update({ state: "superseded" }).eq("id", currentActive.id);
    }
  }

  // --- 4. Assumptions
  if (interpretation.assumptions?.length) {
    const rows = interpretation.assumptions.map((a, i) => ({
      id: `assum-${now}-${i}`,
      team_space_id: teamSpaceId,
      statement: a.statement,
      state: a.state ?? "holds",
      tied_to: a.tiedTo ?? null,
    }));
    const { error } = await supabase.from("assumptions").insert(rows);
    if (error) throw error;
  }

  // --- 5. Interventions
  if (interpretation.interventions?.length) {
    const rows = interpretation.interventions.map((iv, i) => ({
      id: `int-${now}-${i}`,
      team_space_id: teamSpaceId,
      title: iv.title,
      rationale: iv.rationale,
      action_kind: iv.actionKind,
      urgency: iv.urgency ?? 3,
      target_type: iv.targetType ?? null,
      state: "suggested" as InterventionState,
    }));
    const { error } = await supabase.from("interventions").insert(rows);
    if (error) throw error;
  }

  // --- 6. Goal confidence signal
  if (interpretation.confidenceImpact?.goalConfidence != null) {
    const { data: active } = await supabase
      .from("goals")
      .select("id")
      .eq("team_space_id", teamSpaceId)
      .eq("state", "active")
      .limit(1)
      .maybeSingle();
    if (active) {
      await supabase
        .from("goals")
        .update({ confidence: interpretation.confidenceImpact.goalConfidence })
        .eq("id", active.id);
      await supabase.from("confidence_signals").insert({
        id: `sig-${now}`,
        team_space_id: teamSpaceId,
        target_id: active.id,
        target_type: "goal",
        confidence: interpretation.confidenceImpact.goalConfidence,
        note: interpretation.confidenceImpact.note ?? null,
      });
    }
  }

  return fetchLatticeState(supabase, teamSpaceId);
}

// Lifted from team-state-db.ts logic but scoped for V2 caller.
async function applyV1ToDatabase(
  supabase: SupabaseClient,
  teamSpaceId: string,
  input: string,
  interpretation: InterpretationV1,
) {
  const v1 = await fetchTeamState(teamSpaceId, supabase);
  const next = applyV1(v1, interpretation);
  const existingFO = new Set(v1.fieldObjects.map((x) => x.id));
  const existingMem = new Set(v1.memory.map((x) => x.id));
  const existingReq = new Set(v1.requests.map((x) => x.id));
  const existingRem = new Set(v1.reminders.map((x) => x.id));
  const newFO = next.fieldObjects.filter((x) => !existingFO.has(x.id));
  const newMem = next.memory.filter((x) => !existingMem.has(x.id));
  const newReq = next.requests.filter((x) => !existingReq.has(x.id));
  const newRem = next.reminders.filter((x) => !existingRem.has(x.id));

  await supabase.from("interpretations").insert({
    team_space_id: teamSpaceId,
    raw_input: input,
    reply: interpretation.reply,
    entities: interpretation.entities,
    follow_up_question: interpretation.followUpQuestion ?? null,
    broadcast: interpretation.broadcast ?? [],
  });

  if (newFO.length) {
    await supabase.from("field_objects").insert(
      newFO.map((o) => ({
        id: o.id,
        team_space_id: teamSpaceId,
        type: o.type as FieldObjectType,
        title: o.title,
        detail: o.detail,
        owner: o.owner ?? null,
        status: o.status ?? null,
        confidence: o.confidence,
        position_x: o.x,
        position_y: o.y,
        pulse: o.pulse,
        links: o.links ?? [],
      })),
    );
  }

  if (newMem.length) {
    await supabase.from("memory_events").insert(
      newMem.map((m: MemoryEvent) => ({
        id: m.id,
        team_space_id: teamSpaceId,
        kind: m.kind === "broadcast" || m.kind === "follow-up" ? null : m.kind,
        text: m.text,
      })),
    );
  }

  if (newReq.length) {
    await supabase.from("delegated_requests").insert(
      newReq.map((r) => ({
        id: r.id,
        team_space_id: teamSpaceId,
        target: r.target,
        ask: r.ask,
        why: r.why,
        state: r.state,
        linked_to: r.linkedTo,
      })),
    );
  }

  if (newRem.length) {
    await supabase.from("reminders").insert(
      newRem.map((r) => ({
        id: r.id,
        team_space_id: teamSpaceId,
        text: r.text,
        trigger: r.trigger,
        linked_to: r.linkedTo,
      })),
    );
  }

  await supabase
    .from("team_spaces")
    .update({
      active_intent: next.intent,
      tensions: next.tensions,
      broadcast: next.broadcast,
    })
    .eq("id", teamSpaceId);
}

export async function updateInterventionState(
  supabase: SupabaseClient,
  id: string,
  state: InterventionState,
  teamSpaceId = DEFAULT_TEAM_SPACE_ID,
): Promise<LatticeState> {
  const patch: Record<string, unknown> = { state };
  if (state === "dismissed") patch.dismissed_at = new Date().toISOString();
  if (state === "acted") patch.acted_at = new Date().toISOString();
  const { error } = await supabase
    .from("interventions")
    .update(patch)
    .eq("id", id)
    .eq("team_space_id", teamSpaceId);
  if (error) throw error;
  return fetchLatticeState(supabase, teamSpaceId);
}

export async function updateAssumptionState(
  supabase: SupabaseClient,
  id: string,
  state: Assumption["state"],
  teamSpaceId = DEFAULT_TEAM_SPACE_ID,
): Promise<LatticeState> {
  const patch: Record<string, unknown> = { state, last_checked_at: new Date().toISOString() };
  const { error } = await supabase
    .from("assumptions")
    .update(patch)
    .eq("id", id)
    .eq("team_space_id", teamSpaceId);
  if (error) throw error;
  return fetchLatticeState(supabase, teamSpaceId);
}

export async function recordChangeEvent(
  supabase: SupabaseClient,
  event: Omit<ChangeEvent, "id" | "createdAt">,
  teamSpaceId = DEFAULT_TEAM_SPACE_ID,
): Promise<LatticeState> {
  const id = `chg-${Date.now()}`;
  const { error } = await supabase.from("change_events").insert({
    id,
    team_space_id: teamSpaceId,
    kind: event.kind,
    summary: event.summary,
    detail: event.detail ?? null,
    target_id: event.targetId ?? null,
    target_type: event.targetType ?? null,
    source: event.source ?? "manual",
    impact: event.impact ?? null,
  });
  if (error) throw error;
  return fetchLatticeState(supabase, teamSpaceId);
}

