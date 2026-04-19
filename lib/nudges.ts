// Derive nudges from current LatticeState. No cron, no storage — pure function
// over state. "Derive on read" means the check-ins are always fresh and never
// stale themselves, but it also means we can't push to Slack or email yet.
// That's a follow-up (path a — Vercel Cron + a nudges table).

import type { LatticeState } from "@/lib/v2";

export type Nudge = {
  id: string;
  kind:
    | "stale_commitment"
    | "open_blocker"
    | "stale_assumption"
    | "overdue_reminder"
    | "overdue_commitment";
  person: string;
  prompt: string; // what the user can send back to Lattice, prefilled
  reason: string; // why we're asking, shown in UI
  targetId?: string;
  ageHours?: number;
  urgency: 1 | 2 | 3;
};

const STALE_COMMITMENT_HOURS = 72;
const STALE_BLOCKER_HOURS = 24;
const STALE_ASSUMPTION_HOURS = 24 * 7;

export function deriveNudges(state: LatticeState): Nudge[] {
  const now = Date.now();
  const out: Nudge[] = [];

  // Index: most-recent change_event per target_id.
  const lastTouch = new Map<string, number>();
  for (const ev of state.changeEvents) {
    if (!ev.targetId) continue;
    const ts = Date.parse(ev.createdAt);
    if (!Number.isFinite(ts)) continue;
    const existing = lastTouch.get(ev.targetId);
    if (existing === undefined || ts > existing) {
      lastTouch.set(ev.targetId, ts);
    }
  }

  // Helper: skip nudging if this item is explicitly deferred.
  const isDeferred = (f: { deferredUntil?: string }): boolean => {
    if (!f.deferredUntil) return false;
    const until = Date.parse(f.deferredUntil);
    return Number.isFinite(until) && until > now;
  };

  // --- Overdue commitments (past due_at, not done/dropped) ---
  for (const f of state.fieldObjects) {
    if (f.type !== "promise") continue;
    if (f.status === "done" || f.status === "dropped") continue;
    if (!f.dueAt) continue;
    const due = Date.parse(f.dueAt);
    if (!Number.isFinite(due) || due >= now) continue;
    if (isDeferred(f)) continue;
    const lateHours = (now - due) / 36e5;
    const person = f.owner?.trim() || "Someone";
    out.push({
      id: `nudge-overdue-${f.id}`,
      kind: "overdue_commitment",
      person,
      targetId: f.id,
      ageHours: Math.round(lateHours),
      urgency: lateHours >= 48 ? 3 : 2,
      reason:
        person === "Someone"
          ? `Past due by ${fmtAge(lateHours)}, no owner.`
          : `${person} is ${fmtAge(lateHours)} past due on this.`,
      prompt:
        person === "Someone"
          ? `"${f.title}" is ${fmtAge(lateHours)} past its deadline and has no owner. Who picks it up?`
          : `${person} — "${f.title}" is ${fmtAge(lateHours)} past its deadline. Still landing, slipped, or do we reassign?`,
    });
  }

  // --- Stale commitments (promises that went quiet) ---
  for (const f of state.fieldObjects) {
    if (f.type !== "promise") continue;
    if (f.status === "done" || f.status === "dropped") continue;
    if (isDeferred(f)) continue;
    const last = lastTouch.get(f.id) ?? 0;
    const ageHours = last ? (now - last) / 36e5 : Number.POSITIVE_INFINITY;
    if (ageHours < STALE_COMMITMENT_HOURS) continue;
    const person = f.owner?.trim() || "Someone";
    out.push({
      id: `nudge-stale-${f.id}`,
      kind: "stale_commitment",
      person,
      targetId: f.id,
      ageHours: Number.isFinite(ageHours) ? Math.round(ageHours) : undefined,
      urgency: ageHours >= STALE_COMMITMENT_HOURS * 2 ? 3 : 2,
      reason:
        person === "Someone"
          ? `No owner, no update in ${fmtAge(ageHours)}.`
          : `${person} hasn't updated this in ${fmtAge(ageHours)}.`,
      prompt: draftStalePrompt(person, f.title, ageHours),
    });
  }

  // --- Open blockers that have gone quiet ---
  for (const f of state.fieldObjects) {
    if (f.type !== "blocker") continue;
    if (f.status === "resolved" || f.status === "dropped") continue;
    if (isDeferred(f)) continue;
    const last = lastTouch.get(f.id) ?? 0;
    const ageHours = last ? (now - last) / 36e5 : Number.POSITIVE_INFINITY;
    if (ageHours < STALE_BLOCKER_HOURS) continue;
    const person = f.owner?.trim() || "Someone";
    out.push({
      id: `nudge-blocker-${f.id}`,
      kind: "open_blocker",
      person,
      targetId: f.id,
      ageHours: Number.isFinite(ageHours) ? Math.round(ageHours) : undefined,
      urgency: ageHours >= 72 ? 3 : 2,
      reason: `Blocker open ${fmtAge(ageHours)} — no movement.`,
      prompt: draftBlockerPrompt(person, f.title, ageHours),
    });
  }

  // --- Assumptions that haven't been revisited ---
  for (const a of state.assumptions) {
    if (a.state === "invalidated") continue;
    const lastTs = a.lastCheckedAt
      ? Date.parse(a.lastCheckedAt)
      : Date.parse(a.updatedAt || a.createdAt);
    if (!Number.isFinite(lastTs)) continue;
    const ageHours = (now - lastTs) / 36e5;
    if (ageHours < STALE_ASSUMPTION_HOURS) continue;
    out.push({
      id: `nudge-assumption-${a.id}`,
      kind: "stale_assumption",
      person: a.tiedTo?.trim() || "The team",
      targetId: a.id,
      ageHours: Math.round(ageHours),
      urgency: a.state === "at_risk" ? 3 : 1,
      reason: `Assumption not revisited in ${fmtAge(ageHours)}${
        a.state === "at_risk" ? " — flagged at-risk" : ""
      }.`,
      prompt: `Is this still true? "${a.statement}"`,
    });
  }

  // --- Overdue reminders ---
  for (const r of state.reminders) {
    const trigger = r.trigger?.toLowerCase() ?? "";
    const probablyPast =
      trigger.includes("yesterday") ||
      trigger.includes("tonight") ||
      trigger.includes("tomorrow") ||
      /^\d/.test(trigger); // "8pm" etc.
    if (!probablyPast) continue;
    out.push({
      id: `nudge-reminder-${r.id}`,
      kind: "overdue_reminder",
      person: "You",
      targetId: r.id,
      urgency: 2,
      reason: `You set this reminder for "${r.trigger}".`,
      prompt: `${r.text} — still relevant, or done?`,
    });
  }

  // Highest urgency first, then newest staleness.
  out.sort(
    (a, b) => b.urgency - a.urgency || (b.ageHours ?? 0) - (a.ageHours ?? 0),
  );
  return out;
}

function fmtAge(hours: number): string {
  if (!Number.isFinite(hours)) return "a while";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function draftStalePrompt(person: string, title: string, hours: number): string {
  const when = Number.isFinite(hours) ? fmtAge(hours) : "a while";
  if (person === "Someone") {
    return `"${title}" has no owner and hasn't moved in ${when}. Who's on it?`;
  }
  return `${person} — "${title}" has been quiet for ${when}. Still on track, or has something shifted?`;
}

function draftBlockerPrompt(person: string, title: string, hours: number): string {
  const when = Number.isFinite(hours) ? fmtAge(hours) : "a while";
  if (person === "Someone") {
    return `The blocker "${title}" has been open ${when} with no owner. Who's chasing it?`;
  }
  return `${person} — the blocker on "${title}" has been open ${when}. Any movement, or do we need to escalate?`;
}
