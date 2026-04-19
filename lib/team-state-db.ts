import {
  applyInterpretation,
  initialTeamState,
  type FieldObject,
  type FieldObjectType,
  type Interpretation,
  type MemoryEvent,
  type RequestState,
  type TeamState,
} from "@/lib/lattice";
import { createSupabaseServerClient } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_TEAM_SPACE_ID = process.env.LATTICE_TEAM_SPACE_ID ?? "demo-team-space";

type TeamSpaceRow = {
  id: string;
  active_intent: string;
  tensions: string[] | null;
  broadcast: string[] | null;
};

type FieldObjectRow = {
  id: string;
  type: FieldObjectType;
  title: string;
  detail: string;
  owner: string | null;
  status: string | null;
  confidence: number | string;
  position_x: number | string;
  position_y: number | string;
  pulse: FieldObject["pulse"];
  links: string[] | null;
  due_at: string | null;
  deferred_until: string | null;
  decline_reason: string | null;
};

type MemoryEventRow = {
  id: string;
  kind: FieldObjectType | null;
  text: string;
  created_at: string;
};

type DelegatedRequestRow = {
  id: string;
  target: string;
  ask: string;
  why: string;
  state: RequestState;
  linked_to: string | null;
};

type ReminderRow = {
  id: string;
  text: string;
  trigger: string;
  linked_to: string | null;
};

function formatMemoryTime(createdAt: string) {
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toFieldObject(row: FieldObjectRow): FieldObject {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    detail: row.detail,
    owner: row.owner ?? undefined,
    status: row.status ?? undefined,
    confidence: Number(row.confidence),
    x: Number(row.position_x),
    y: Number(row.position_y),
    pulse: row.pulse,
    links: row.links ?? [],
    dueAt: row.due_at ?? undefined,
    deferredUntil: row.deferred_until ?? undefined,
    declineReason: row.decline_reason ?? undefined,
  };
}

function toMemoryEvent(row: MemoryEventRow): MemoryEvent {
  return {
    id: row.id,
    at: formatMemoryTime(row.created_at),
    text: row.text,
    kind: row.kind ?? "signal",
  };
}

export async function fetchTeamState(teamSpaceId = DEFAULT_TEAM_SPACE_ID, client?: SupabaseClient): Promise<TeamState> {
  const supabase = client ?? createSupabaseServerClient();

  if (!supabase) {
    return initialTeamState;
  }

  const [{ data: space, error: spaceError }, fieldObjects, memory, requests, reminders] = await Promise.all([
    supabase
      .from("team_spaces")
      .select("id, active_intent, tensions, broadcast")
      .eq("id", teamSpaceId)
      .single<TeamSpaceRow>(),
    supabase
      .from("field_objects")
      .select(
        "id, type, title, detail, owner, status, confidence, position_x, position_y, pulse, links, due_at, deferred_until, decline_reason",
      )
      .eq("team_space_id", teamSpaceId)
      .order("created_at", { ascending: true }),
    supabase
      .from("memory_events")
      .select("id, kind, text, created_at")
      .eq("team_space_id", teamSpaceId)
      .order("created_at", { ascending: false }),
    supabase
      .from("delegated_requests")
      .select("id, target, ask, why, state, linked_to")
      .eq("team_space_id", teamSpaceId)
      .order("created_at", { ascending: false }),
    supabase
      .from("reminders")
      .select("id, text, trigger, linked_to")
      .eq("team_space_id", teamSpaceId)
      .is("resolved_at", null)
      .order("created_at", { ascending: false }),
  ]);

  if (spaceError || !space) {
    return initialTeamState;
  }

  if (fieldObjects.error) throw fieldObjects.error;
  if (memory.error) throw memory.error;
  if (requests.error) throw requests.error;
  if (reminders.error) throw reminders.error;

  return {
    intent: space.active_intent,
    fieldObjects: ((fieldObjects.data ?? []) as FieldObjectRow[]).map(toFieldObject),
    memory: ((memory.data ?? []) as MemoryEventRow[]).map(toMemoryEvent),
    requests: ((requests.data ?? []) as DelegatedRequestRow[]).map((request) => ({
      id: request.id,
      target: request.target,
      ask: request.ask,
      why: request.why,
      state: request.state,
      linkedTo: request.linked_to ?? space.active_intent,
    })),
    reminders: ((reminders.data ?? []) as ReminderRow[]).map((reminder) => ({
      id: reminder.id,
      text: reminder.text,
      trigger: reminder.trigger,
      linkedTo: reminder.linked_to ?? space.active_intent,
    })),
    tensions: space.tensions ?? [],
    broadcast: space.broadcast ?? [],
  };
}

export async function applyInterpretationToDatabase(
  input: string,
  interpretation: Interpretation,
  teamSpaceId = DEFAULT_TEAM_SPACE_ID,
  client?: SupabaseClient,
) {
  const supabase = client ?? createSupabaseServerClient();

  if (!supabase) {
    return applyInterpretation(initialTeamState, interpretation);
  }

  const current = await fetchTeamState(teamSpaceId, supabase);
  const next = applyInterpretation(current, interpretation);
  const currentFieldObjectIds = new Set(current.fieldObjects.map((object) => object.id));
  const currentMemoryIds = new Set(current.memory.map((event) => event.id));
  const currentRequestIds = new Set(current.requests.map((request) => request.id));
  const currentReminderIds = new Set(current.reminders.map((reminder) => reminder.id));

  const newFieldObjects = next.fieldObjects.filter((object) => !currentFieldObjectIds.has(object.id));
  const newMemoryEvents = next.memory.filter((event) => !currentMemoryIds.has(event.id));
  const newRequests = next.requests.filter((request) => !currentRequestIds.has(request.id));
  const newReminders = next.reminders.filter((reminder) => !currentReminderIds.has(reminder.id));

  const { error: interpretationError } = await supabase.from("interpretations").insert({
    team_space_id: teamSpaceId,
    raw_input: input,
    reply: interpretation.reply,
    entities: interpretation.entities,
    follow_up_question: interpretation.followUpQuestion ?? null,
    broadcast: interpretation.broadcast ?? [],
  });
  if (interpretationError) throw interpretationError;

  if (newFieldObjects.length) {
    const { error } = await supabase.from("field_objects").insert(
      newFieldObjects.map((object) => ({
        id: object.id,
        team_space_id: teamSpaceId,
        type: object.type,
        title: object.title,
        detail: object.detail,
        owner: object.owner ?? null,
        status: object.status ?? null,
        confidence: object.confidence,
        position_x: object.x,
        position_y: object.y,
        pulse: object.pulse,
        links: object.links ?? [],
        due_at: object.dueAt ?? null,
      })),
    );
    if (error) throw error;
  }

  if (newMemoryEvents.length) {
    const { error } = await supabase.from("memory_events").insert(
      newMemoryEvents.map((event) => ({
        id: event.id,
        team_space_id: teamSpaceId,
        kind: event.kind === "broadcast" || event.kind === "follow-up" ? null : event.kind,
        text: event.text,
      })),
    );
    if (error) throw error;
  }

  if (newRequests.length) {
    const { error } = await supabase.from("delegated_requests").insert(
      newRequests.map((request) => ({
        id: request.id,
        team_space_id: teamSpaceId,
        target: request.target,
        ask: request.ask,
        why: request.why,
        state: request.state,
        linked_to: request.linkedTo,
      })),
    );
    if (error) throw error;
  }

  if (newReminders.length) {
    const { error } = await supabase.from("reminders").insert(
      newReminders.map((reminder) => ({
        id: reminder.id,
        team_space_id: teamSpaceId,
        text: reminder.text,
        trigger: reminder.trigger,
        linked_to: reminder.linkedTo,
      })),
    );
    if (error) throw error;
  }

  const { error: spaceError } = await supabase
    .from("team_spaces")
    .update({
      active_intent: next.intent,
      tensions: next.tensions,
      broadcast: next.broadcast,
    })
    .eq("id", teamSpaceId);
  if (spaceError) throw spaceError;

  return fetchTeamState(teamSpaceId, supabase);
}

export async function updateRequestStateInDatabase(
  id: string,
  state: RequestState,
  teamSpaceId = DEFAULT_TEAM_SPACE_ID,
  client?: SupabaseClient,
) {
  const supabase = client ?? createSupabaseServerClient();

  if (!supabase) {
    return initialTeamState;
  }

  const { error } = await supabase
    .from("delegated_requests")
    .update({ state })
    .eq("id", id)
    .eq("team_space_id", teamSpaceId);

  if (error) throw error;

  return fetchTeamState(teamSpaceId, supabase);
}
