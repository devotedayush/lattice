// Derive per-person delivery stats from current LatticeState. Read-only —
// no storage. Feeds both the UI (member chips, Manage Team modal) and the
// AI context (so suggested owner assignments can consider who's fast,
// who's overloaded, who keeps declining).

import type { MemberStats } from "@/lib/teams";
import type { LatticeState } from "@/lib/v2";

const norm = (s?: string | null): string => (s ?? "").trim().toLowerCase();

export function statsForMember(
  state: LatticeState,
  memberName: string,
): MemberStats {
  const target = norm(memberName);
  if (!target) return emptyStats();

  // Index completed commitments by id from change_events (commitment_completed).
  const completedAt = new Map<string, number>();
  for (const ev of state.changeEvents) {
    if (ev.kind !== "commitment_completed") continue;
    if (!ev.targetId) continue;
    const ts = Date.parse(ev.createdAt);
    if (!Number.isFinite(ts)) continue;
    const existing = completedAt.get(ev.targetId);
    if (existing === undefined || ts > existing) completedAt.set(ev.targetId, ts);
  }

  // First-seen for each target — approximate "assigned at" from the earliest
  // change_event that touched it. Fallback: 0 so we skip the row.
  const firstTouch = new Map<string, number>();
  for (const ev of [...state.changeEvents].reverse()) {
    if (!ev.targetId) continue;
    const ts = Date.parse(ev.createdAt);
    if (!Number.isFinite(ts)) continue;
    if (!firstTouch.has(ev.targetId)) firstTouch.set(ev.targetId, ts);
  }

  const now = Date.now();
  let completed = 0;
  let openCount = 0;
  let overdueCount = 0;
  let declinedCount = 0;
  let onTimeHits = 0;
  let onTimeTotal = 0;
  let deliveryHoursSum = 0;
  let deliveryHoursCount = 0;

  for (const f of state.fieldObjects) {
    if (f.type !== "promise" && f.type !== "request") continue;
    if (norm(f.owner) !== target) continue;

    const done = f.status === "done" || f.status === "resolved";
    const dropped = f.status === "dropped";

    if (done) {
      completed += 1;
      const doneAt = completedAt.get(f.id);
      const start = firstTouch.get(f.id);
      if (doneAt && start && doneAt > start) {
        deliveryHoursSum += (doneAt - start) / 36e5;
        deliveryHoursCount += 1;
      }
      if (f.dueAt) {
        onTimeTotal += 1;
        const due = Date.parse(f.dueAt);
        if (Number.isFinite(due) && doneAt && doneAt <= due) onTimeHits += 1;
      }
      continue;
    }

    if (dropped) {
      if (f.declineReason) declinedCount += 1;
      continue;
    }

    openCount += 1;
    if (f.dueAt) {
      const due = Date.parse(f.dueAt);
      if (Number.isFinite(due) && due < now) overdueCount += 1;
    }
  }

  return {
    completed,
    openCount,
    overdueCount,
    declinedCount,
    onTimeRate: onTimeTotal > 0 ? onTimeHits / onTimeTotal : null,
    avgDeliveryHours:
      deliveryHoursCount > 0 ? Math.round(deliveryHoursSum / deliveryHoursCount) : null,
  };
}

export function statsForAllMembers(
  state: LatticeState,
  names: string[],
): Record<string, MemberStats> {
  const out: Record<string, MemberStats> = {};
  for (const name of names) out[name] = statsForMember(state, name);
  return out;
}

function emptyStats(): MemberStats {
  return {
    completed: 0,
    openCount: 0,
    overdueCount: 0,
    declinedCount: 0,
    onTimeRate: null,
    avgDeliveryHours: null,
  };
}

// Short human-readable summary used in AI prompts + hover tooltips.
export function summarizeStats(s: MemberStats): string {
  const bits: string[] = [];
  bits.push(`${s.completed} shipped`);
  if (s.openCount) bits.push(`${s.openCount} open`);
  if (s.overdueCount) bits.push(`${s.overdueCount} overdue`);
  if (s.declinedCount) bits.push(`${s.declinedCount} declined`);
  if (s.onTimeRate !== null) bits.push(`${Math.round(s.onTimeRate * 100)}% on-time`);
  if (s.avgDeliveryHours !== null) bits.push(`~${s.avgDeliveryHours}h avg`);
  return bits.join(" · ");
}
