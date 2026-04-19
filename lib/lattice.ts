export type FieldObjectType =
  | "intent"
  | "promise"
  | "blocker"
  | "shift"
  | "request"
  | "reminder"
  | "signal";

export type RequestState = "draft" | "sent" | "acknowledged" | "resolved" | "denied";

export type FieldObject = {
  id: string;
  type: FieldObjectType;
  title: string;
  detail: string;
  owner?: string;
  status?: string;
  confidence: number;
  x: number;
  y: number;
  pulse: "quiet" | "active" | "tense" | "stale" | "clear";
  links?: string[];
  dueAt?: string;
  deferredUntil?: string;
  declineReason?: string;
};

export type MemoryEvent = {
  id: string;
  at: string;
  text: string;
  kind: FieldObjectType | "broadcast" | "follow-up";
};

export type DelegatedRequest = {
  id: string;
  target: string;
  ask: string;
  why: string;
  state: RequestState;
  linkedTo: string;
};

export type Reminder = {
  id: string;
  text: string;
  trigger: string;
  linkedTo: string;
};

export type InterpretationEntity = {
  type: FieldObjectType;
  title: string;
  detail: string;
  owner?: string;
  trigger?: string;
  target?: string;
  why?: string;
  linkedTo?: string;
  confidence?: number;
  dueAt?: string; // ISO
};

export type Interpretation = {
  reply: string;
  entities: InterpretationEntity[];
  followUpQuestion?: string;
  broadcast?: string[];
};

export type TeamState = {
  intent: string;
  fieldObjects: FieldObject[];
  memory: MemoryEvent[];
  requests: DelegatedRequest[];
  reminders: Reminder[];
  tensions: string[];
  broadcast: string[];
};

export const initialTeamState: TeamState = {
  intent: "Ship a demo people trust",
  fieldObjects: [
    {
      id: "intent-demo",
      type: "intent",
      title: "Demo reliability",
      detail: "The team is optimizing for a stable judge walkthrough.",
      owner: "Team",
      status: "primary intent",
      confidence: 0.82,
      x: 50,
      y: 46,
      pulse: "active",
      links: ["promise-onboarding", "blocker-backend", "request-analytics"],
    },
    {
      id: "promise-onboarding",
      type: "promise",
      title: "Onboarding flow",
      detail: "Aryan will finish the core flow before tonight's dry run.",
      owner: "Aryan",
      status: "in motion",
      confidence: 0.68,
      x: 33,
      y: 31,
      pulse: "clear",
      links: ["intent-demo"],
    },
    {
      id: "blocker-backend",
      type: "blocker",
      title: "Auth edge cases",
      detail: "Backend auth is unstable around new user sessions.",
      owner: "Meera",
      status: "blocking deployment",
      confidence: 0.44,
      x: 69,
      y: 34,
      pulse: "tense",
      links: ["intent-demo", "reminder-auth"],
    },
    {
      id: "request-analytics",
      type: "request",
      title: "Analytics deprioritization",
      detail: "Ask lead to pause analytics and protect demo flow.",
      owner: "Lattice",
      status: "draft",
      confidence: 0.59,
      x: 62,
      y: 66,
      pulse: "active",
      links: ["intent-demo"],
    },
    {
      id: "reminder-auth",
      type: "reminder",
      title: "Retry auth test",
      detail: "Bring back the auth test after backend patch lands.",
      owner: "Me",
      status: "8:00 PM",
      confidence: 0.77,
      x: 39,
      y: 70,
      pulse: "quiet",
      links: ["blocker-backend"],
    },
  ],
  memory: [
    {
      id: "mem-1",
      at: "09:20",
      text: "Goal shifted from feature breadth to demo reliability.",
      kind: "shift",
    },
    {
      id: "mem-2",
      at: "10:05",
      text: "Auth edge cases linked to deployment risk.",
      kind: "blocker",
    },
    {
      id: "mem-3",
      at: "10:18",
      text: "Analytics pause request drafted for lead approval.",
      kind: "request",
    },
  ],
  requests: [
    {
      id: "req-1",
      target: "Team lead",
      ask: "Can analytics pause while the demo flow gets stabilized?",
      why: "Demo reliability is the current team intent.",
      state: "draft",
      linkedTo: "Demo reliability",
    },
  ],
  reminders: [
    {
      id: "rem-1",
      text: "Retry auth test after backend patch",
      trigger: "8:00 PM",
      linkedTo: "Auth edge cases",
    },
  ],
  tensions: [
    "Auth edge cases still affect deployment confidence.",
    "Analytics scope is waiting on lead approval.",
    "Onboarding promise has no latest update after the scope shift.",
  ],
  broadcast: [
    "Demo reliability is now the active team intent.",
    "Backend auth remains the main deployment blocker.",
    "Analytics may be deprioritized pending approval.",
  ],
};

const typePulse: Record<FieldObjectType, FieldObject["pulse"]> = {
  intent: "active",
  promise: "clear",
  blocker: "tense",
  shift: "active",
  request: "active",
  reminder: "quiet",
  signal: "quiet",
};

export function fallbackInterpretation(input: string): Interpretation {
  const text = input.trim();
  const lower = text.toLowerCase();
  const entities: InterpretationEntity[] = [];

  if (lower.includes("remind") || lower.includes("tomorrow") || lower.includes("tonight")) {
    entities.push({
      type: "reminder",
      title: "Follow-up reminder",
      detail: text,
      trigger: lower.includes("tomorrow") ? "Tomorrow" : lower.includes("tonight") ? "Tonight" : "Later",
    });
  }

  if (lower.includes("ask ") || lower.includes("tell ") || lower.includes("request ")) {
    entities.push({
      type: "request",
      title: "Delegated ask",
      detail: text,
      target: inferTarget(text),
      why: "Requested from the latest team update.",
    });
  }

  if (lower.includes("blocked") || lower.includes("waiting") || lower.includes("stuck")) {
    entities.push({
      type: "blocker",
      title: "New blocker",
      detail: text,
    });
  }

  if (lower.includes("changed") || lower.includes("no longer") || lower.includes("scope")) {
    entities.push({
      type: "shift",
      title: "Direction shift",
      detail: text,
    });
  }

  if (lower.includes("finished") || lower.includes("working") || lower.includes("done") || lower.includes("complete")) {
    entities.push({
      type: "promise",
      title: "Promise update",
      detail: text,
    });
  }

  if (entities.length === 0) {
    entities.push({
      type: "signal",
      title: "Team signal",
      detail: text,
    });
  }

  return {
    reply: entities.map((entity) => `${labelFor(entity.type)} captured: ${entity.title}.`).join(" "),
    entities,
    followUpQuestion:
      lower.includes("changes") || lower.includes("changed")
        ? "Was the change in requirement, dependency, or technical difficulty?"
        : undefined,
    broadcast: entities.some((entity) => entity.type === "blocker" || entity.type === "shift")
      ? ["A team-relevant change was added to the field.", "Review linked promises for drift."]
      : undefined,
  };
}

export function applyInterpretation(state: TeamState, interpretation: Interpretation): TeamState {
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const created = interpretation.entities.map((entity, index) => toFieldObject(entity, state.fieldObjects.length + index));
  const memory = interpretation.entities.map((entity, index) => ({
    id: `mem-${now.getTime()}-${index}`,
    at: stamp,
    text: `${labelFor(entity.type)}: ${entity.title} - ${entity.detail}`,
    kind: entity.type,
  }));
  const requests = [
    ...interpretation.entities
      .filter((entity) => entity.type === "request")
      .map((entity, index) => ({
        id: `req-${now.getTime()}-${index}`,
        target: entity.target ?? "Teammate",
        ask: entity.detail,
        why: entity.why ?? "It matters to the current team intent.",
        state: "draft" as RequestState,
        linkedTo: entity.linkedTo ?? state.intent,
      })),
    ...state.requests,
  ];

  return {
    ...state,
    intent: interpretation.entities.find((entity) => entity.type === "intent")?.title ?? state.intent,
    fieldObjects: [...state.fieldObjects, ...created],
    memory: [...memory, ...state.memory],
    requests,
    reminders: [
      ...interpretation.entities
        .filter((entity) => entity.type === "reminder")
        .map((entity, index) => ({
          id: `rem-${now.getTime()}-${index}`,
          text: entity.detail,
          trigger: entity.trigger ?? "Later",
          linkedTo: entity.linkedTo ?? state.intent,
        })),
      ...state.reminders,
    ],
    tensions: deriveTensions([...state.fieldObjects, ...created], requests),
    broadcast: interpretation.broadcast?.length ? interpretation.broadcast : state.broadcast,
  };
}

export function labelFor(type: FieldObjectType) {
  const labels: Record<FieldObjectType, string> = {
    intent: "Intent",
    promise: "Commitment",
    blocker: "Blocker",
    shift: "Shift",
    request: "Request",
    reminder: "Reminder",
    signal: "Signal",
  };

  return labels[type];
}

function toFieldObject(entity: InterpretationEntity, offset: number): FieldObject {
  const ring = offset % 8;
  return {
    id: `${entity.type}-${Date.now()}-${offset}`,
    type: entity.type,
    title: entity.title,
    detail: entity.detail,
    owner: entity.owner ?? (entity.type === "request" ? "Lattice" : undefined),
    status: entity.trigger ?? entity.target ?? "new",
    confidence:
      typeof entity.confidence === "number"
        ? Math.max(0, Math.min(1, entity.confidence))
        : 0.7,
    x: 22 + ((ring * 17) % 60),
    y: 24 + ((ring * 23) % 54),
    pulse: typePulse[entity.type],
    links: [],
    dueAt: entity.dueAt,
  };
}

function deriveTensions(objects: FieldObject[], requests: DelegatedRequest[]) {
  const blockers = objects
    .filter((object) => object.type === "blocker")
    .slice(-2)
    .map((object) => `${object.title} is still unresolved.`);
  const pending = requests
    .filter((request) => request.state === "draft" || request.state === "sent")
    .slice(0, 2)
    .map((request) => `${request.ask} is waiting on ${request.target}.`);

  return [...blockers, ...pending].slice(0, 4);
}

function inferTarget(text: string) {
  const match = text.match(/\b(?:ask|tell|request)\s+([A-Z][a-z]+|the\s+[a-z\s]+?)\b/);
  return match?.[1]?.trim() ?? "Teammate";
}
