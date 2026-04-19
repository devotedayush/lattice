import OpenAI from "openai";

import { statsForAllMembers, summarizeStats } from "@/lib/member-stats";
import { LATTICE_PERSONA } from "@/lib/persona";
import type { TeamMemberRecord } from "@/lib/teams";
import type {
  DetectedChangeEvent,
  DetectedIntervention,
  InterpretationV2,
  LatticeState,
} from "@/lib/v2";

const systemPrompt = `${LATTICE_PERSONA}

Right now you are ingesting a single natural-language update from a teammate and returning structured state. You do not manage tasks. You model the evolving reality of a team.

You are given:
- the team's current GOAL
- CURRENT COMMITMENTS (promises/blockers/requests/etc.)
- OPEN ASSUMPTIONS
- RECENT CHANGES

Then you receive a single natural-language UPDATE from one teammate.

Produce a JSON object with this exact shape:
{
  "reply": string,                         // one-sentence confirmation, warm, not robotic
  "richReply": {
    "headline": string,                    // one-line plain-English interpretation
    "recorded": string[],                  // bullet list of what was recorded (progress, blocker, etc.)
    "implications": string[],              // 1-3 bullets of what this implies for the team
    "suggested": string[]                  // 1-3 concrete next steps
  },
  "entities": [                            // V1 surface entities (keep these — shown in the field)
    { "type": "intent"|"promise"|"blocker"|"shift"|"request"|"reminder"|"signal",
      "title": string, "detail": string, "owner"?: string, "trigger"?: string,
      "target"?: string, "why"?: string, "linkedTo"?: string, "confidence"?: number,
      "dueAt"?: string /* ISO 8601 if the input mentions a deadline like "by Friday", "tomorrow EOD", "May 5", "in 3 days" — resolve relative dates to absolute UTC */ }
  ],
  "changes": [                             // first-class change events this update implies
    { "kind": "goal_shift"|"scope_change"|"priority_change"|"deadline_move"|"owner_change"
            |"blocker_emerged"|"blocker_resolved"|"assumption_invalidated"
            |"confidence_change"|"commitment_added"|"commitment_completed"|"commitment_stale",
      "summary": string, "detail"?: string, "targetType"?: string,
      "teamReadable"?: string, "affects"?: string[] }
  ],
  "goalShift"?: { "mode":"replace"|"adjust"|"new", "title": string, "detail"?: string, "confidence"?: number },
  "assumptions"?: [ { "statement": string, "state"?: "holds"|"at_risk"|"invalidated"|"reconfirmed", "tiedTo"?: string } ],
  "interventions"?: [
    { "title": string, "rationale": string,
      "actionKind": "clarify"|"reconfirm"|"escalate"|"notify"|"reduce_scope"|"support"|"reprioritize",
      "urgency"?: 1|2|3|4|5, "targetType"?: string }
  ],
  "followUpQuestion"?: string,             // only when ambiguity would corrupt the state
  "broadcast"?: string[],                  // short team-wide bullets if >1 person affected
  "confidenceImpact"?: { "goalConfidence"?: number, "note"?: string }
}

Principles:
- Be concrete. Prefer naming the commitment/person/goal affected.
- If the update implies goal change, emit a "goal_shift" change AND a goalShift object.
- If it mentions "blocked", "waiting on", "stuck" → blocker + blocker_emerged.
- If it mentions "finished", "done", "shipped" → update promise + commitment_completed.
- If scope narrowed/expanded → scope_change; deadline moved → deadline_move.
- Prefer reusing an existing goal/commitment rather than duplicating.
- Suggested next steps should be small, specific, and actionable.
- Reply in the user's tone; never lecture.

Due date extraction:
- If the input includes a deadline ("by Friday", "tomorrow EOD", "before the 5th", "in 3 days", "end of week"), resolve to an absolute ISO 8601 UTC timestamp in dueAt. Use the current time as the anchor. Do not invent a due date if none is stated.
- "EOD" = 23:59 local-equivalent UTC of that day. "Morning" = 09:00. If only a day is given, assume end of day (23:59).

Owner extraction rules (critical — do not violate):
- If the input names a specific person as the owner (e.g. "assigned to Priya", "Raj will do X", "Meera is handling Y", "to Know2"), put ONLY that person's name in the "owner" field. Prefer the exact name as written.
- Strip assignment phrasing from the entity "title" — the title should describe the work, not include "assigned to ___". "Demo video assigned to know2" → title: "Demo video", owner: "know2".
- If the reporter says "I / me / my / self", that is not a specific assignment. Leave "owner" empty — do not use "me", "self", "you", or the reporter's name.
- If no person is named, leave "owner" empty. Never default to the reporter. Never guess.
- If multiple items are assigned to multiple people in one update, emit multiple entities, each with the correct single owner.
- When a TEAM_MEMBERS block is present with skills/focus/delivery stats, prefer a named owner that matches the work. Only suggest in "reply" or "suggested" — never set owner yourself unless the reporter explicitly named a person. When suggesting, cite the reason briefly ("skills match", "low current load", "shipped 3 similar last month").`;

function buildContextBlock(state: LatticeState, members: TeamMemberRecord[] = []): string {
  const activeGoal = state.goals.find((g) => g.state === "active");
  const commitments = state.fieldObjects
    .filter((f) => f.type === "promise" || f.type === "blocker" || f.type === "request")
    .slice(-10)
    .map(
      (f) =>
        `- [${f.type}] ${f.title}${f.owner ? ` (owner: ${f.owner})` : ""}${
          f.status ? ` — ${f.status}` : ""
        } [conf ${f.confidence.toFixed(2)}]`,
    )
    .join("\n");
  const assumptions = state.assumptions
    .slice(0, 8)
    .map((a) => `- [${a.state}] ${a.statement}`)
    .join("\n");
  const recent = state.changeEvents
    .slice(0, 5)
    .map((c) => `- ${c.kind}: ${c.summary}`)
    .join("\n");

  let memberBlock = "";
  if (members.length) {
    const stats = statsForAllMembers(
      state,
      members.map((m) => m.name),
    );
    memberBlock = members
      .map((m) => {
        const skills = m.skills?.length ? ` · skills: ${m.skills.join(", ")}` : "";
        const focus = m.focus ? ` · focus: ${m.focus}` : "";
        const s = summarizeStats(stats[m.name]);
        return `- ${m.name} (${m.role})${skills}${focus} — ${s}`;
      })
      .join("\n");
  }

  return [
    `GOAL: ${activeGoal ? `${activeGoal.title} (confidence ${activeGoal.confidence.toFixed(2)})` : state.intent || "—"}`,
    activeGoal?.detail ? `GOAL_DETAIL: ${activeGoal.detail}` : "",
    memberBlock ? `TEAM_MEMBERS (with delivery history):\n${memberBlock}` : "",
    commitments ? `CURRENT_COMMITMENTS:\n${commitments}` : "",
    assumptions ? `OPEN_ASSUMPTIONS:\n${assumptions}` : "",
    recent ? `RECENT_CHANGES:\n${recent}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function interpretV2(
  input: string,
  state: LatticeState,
  members: TeamMemberRecord[] = [],
): Promise<InterpretationV2> {
  const text = input.trim();
  if (!text) {
    return {
      reply: "Nothing to record yet.",
      entities: [],
      changes: [],
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return fallbackInterpretV2(text, state);
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Context:\n\n${buildContextBlock(state, members)}\n\nUPDATE:\n${text}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const content = completion.choices[0]?.message.content;
    if (!content) return fallbackInterpretV2(text, state);
    const parsed = JSON.parse(content) as InterpretationV2;
    if (!parsed.reply || !Array.isArray(parsed.entities) || !Array.isArray(parsed.changes)) {
      return fallbackInterpretV2(text, state);
    }
    return parsed;
  } catch {
    return fallbackInterpretV2(text, state);
  }
}

// Heuristic fallback for when OpenAI is unavailable. Produces a reasonable
// V2 interpretation so the demo still works end to end.
export function fallbackInterpretV2(text: string, state: LatticeState): InterpretationV2 {
  const lower = text.toLowerCase();
  const entities: InterpretationV2["entities"] = [];
  const changes: DetectedChangeEvent[] = [];
  const interventions: DetectedIntervention[] = [];
  let goalShift: InterpretationV2["goalShift"] = null;
  const recorded: string[] = [];
  const implications: string[] = [];
  const suggested: string[] = [];

  const hasBlocker = /\b(block(ed|er)|waiting|stuck|stall|unstable|broken)\b/.test(lower);
  const hasDone = /\b(finished|done|shipped|complete[d]?|merged|live)\b/.test(lower);
  const hasShift = /\b(changed|no longer|instead|focus(?:ing)? on|pivot|drop(?:ping)?)\b/.test(lower);
  const hasRequest = /\b(ask|tell|request|can (you|someone)|need(s|ed)?)\b/.test(lower);
  const hasRemind = /\b(remind|tonight|tomorrow|later|at \d)\b/.test(lower);
  const hasGoal = /\b(goal|aim|focus(?:ing)? on|priority|north star|demo|launch)\b/.test(lower);

  if (hasBlocker) {
    entities.push({ type: "blocker", title: "New blocker", detail: text });
    changes.push({
      kind: "blocker_emerged",
      summary: "A new blocker was reported",
      detail: text,
      teamReadable: "A teammate is currently blocked.",
    });
    recorded.push("Active blocker recorded.");
    implications.push("Downstream commitments may slip if unresolved.");
    suggested.push("Link the blocker to affected commitments.");
    interventions.push({
      title: "Pair or escalate the blocker",
      rationale: "Blockers reported by a single owner tend to recur.",
      actionKind: "support",
      urgency: 4,
      targetType: "blocker",
    });
  }

  if (hasDone) {
    entities.push({ type: "promise", title: "Progress update", detail: text, confidence: 0.85 });
    changes.push({
      kind: "commitment_completed",
      summary: "Progress reported on a commitment",
      detail: text,
    });
    recorded.push("Progress marked.");
  }

  if (hasShift) {
    entities.push({ type: "shift", title: "Direction shift", detail: text });
    changes.push({
      kind: "scope_change",
      summary: "Scope or direction shifted",
      detail: text,
      teamReadable: "The team's focus changed — review affected work.",
    });
    implications.push("Previously scoped work may now be stale.");
    suggested.push("Mark deprioritized items so the team can see the shift.");
    if (hasGoal) {
      goalShift = {
        mode: "adjust",
        title: text.slice(0, 60),
        detail: text,
        confidence: 0.65,
      };
      changes.push({
        kind: "goal_shift",
        summary: "Goal re-focused",
        detail: text,
        targetType: "goal",
      });
    }
  }

  if (hasRequest) {
    entities.push({
      type: "request",
      title: "Delegated ask",
      detail: text,
      target: inferTarget(text),
      why: "Raised in latest update.",
    });
    recorded.push("Delegated request drafted.");
  }

  if (hasRemind) {
    entities.push({
      type: "reminder",
      title: "Follow-up reminder",
      detail: text,
      trigger: lower.includes("tomorrow") ? "Tomorrow" : lower.includes("tonight") ? "Tonight" : "Later",
    });
    recorded.push("Reminder queued.");
  }

  if (entities.length === 0) {
    entities.push({ type: "signal", title: "Team signal", detail: text });
    recorded.push("Signal recorded to team memory.");
  }

  const activeGoal = state.goals.find((g) => g.state === "active");
  const confidenceImpact =
    hasBlocker && activeGoal
      ? {
          goalConfidence: Math.max(0.25, activeGoal.confidence - 0.08),
          note: "Goal confidence lowered due to new blocker.",
        }
      : undefined;

  return {
    reply: recorded.length ? `Recorded: ${recorded.join(" ")}` : "Recorded.",
    richReply: {
      headline: hasBlocker
        ? "You're blocked — logged and linked to current goal."
        : hasDone
        ? "Progress noted — team memory updated."
        : hasShift
        ? "Direction change captured — team will see the shift."
        : "Update captured.",
      recorded,
      implications,
      suggested,
    },
    entities,
    changes,
    goalShift,
    interventions,
    confidenceImpact,
    followUpQuestion: hasShift && !hasGoal ? "Does this change your current goal or just one commitment?" : undefined,
  };
}

function inferTarget(text: string): string {
  const match = text.match(/\b(?:ask|tell|request|with)\s+([A-Z][a-zA-Z]+|the\s+[a-z\s]+?)\b/);
  return match?.[1]?.trim() ?? "Teammate";
}
