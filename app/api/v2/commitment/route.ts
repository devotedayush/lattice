import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import type { ChangeKind } from "@/lib/v2";
import { fetchLatticeState } from "@/lib/v2-db";

type Action =
  | "complete"
  | "resolve"
  | "drop"
  | "set_confidence"
  | "set_owner"
  | "set_due"
  | "defer"
  | "decline"
  | "scope_change";

// PATCH /api/v2/commitment
//   { id, action, confidence?, owner?, dueAt?, deferredUntil?, reason?, teamId? }
//
// Updates a field_object (promise/blocker) and logs a change event.
export async function PATCH(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: {
    id?: string;
    action?: Action;
    confidence?: number;
    owner?: string | null;
    dueAt?: string | null;
    deferredUntil?: string | null;
    reason?: string | null;
    teamId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.id || !body.action) {
    return NextResponse.json({ error: "id and action required." }, { status: 400 });
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const { data: existing, error: exErr } = await auth.supabase
      .from("field_objects")
      .select("id, type, title, status, confidence, owner")
      .eq("id", body.id)
      .eq("team_space_id", team.id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const OWNER_GATED: Action[] = [
      "complete",
      "resolve",
      "drop",
      "set_owner",
      "set_due",
      "defer",
      "decline",
      "scope_change",
    ];
    if (
      body.action &&
      OWNER_GATED.includes(body.action) &&
      team.role !== "owner" &&
      team.role !== "admin"
    ) {
      const { data: me } = await auth.supabase
        .from("team_members")
        .select("name")
        .eq("team_space_id", team.id)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      const myName = (me?.name as string | undefined)?.trim().toLowerCase();
      const itemOwner = (existing.owner as string | null | undefined)?.trim().toLowerCase();
      if (!myName || !itemOwner || myName !== itemOwner) {
        return NextResponse.json(
          { error: "Only the current owner (or a team admin) can change this." },
          { status: 403 },
        );
      }
    }

    const patch: Record<string, unknown> = {};
    let changeKind: ChangeKind | null = null;
    let summary = "";

    switch (body.action) {
      case "complete":
        patch.status = "done";
        patch.pulse = "clear";
        patch.confidence = 1;
        changeKind = "commitment_completed";
        summary = `Completed: ${existing.title}`;
        break;
      case "resolve":
        patch.status = "resolved";
        patch.pulse = "clear";
        changeKind = existing.type === "blocker" ? "blocker_resolved" : "commitment_completed";
        summary = `Resolved: ${existing.title}`;
        break;
      case "drop":
        patch.status = "dropped";
        patch.pulse = "quiet";
        changeKind = "scope_change";
        summary = `Dropped: ${existing.title}`;
        break;
      case "set_confidence":
        if (typeof body.confidence !== "number") {
          return NextResponse.json({ error: "confidence required." }, { status: 400 });
        }
        patch.confidence = body.confidence;
        changeKind = "confidence_change";
        summary = `Confidence on "${existing.title}" now ${Math.round(body.confidence * 100)}%`;
        break;
      case "set_owner": {
        const nextOwner =
          typeof body.owner === "string" && body.owner.trim().length > 0
            ? body.owner.trim()
            : null;
        patch.owner = nextOwner;
        changeKind = "owner_change";
        summary = nextOwner
          ? `"${existing.title}" reassigned to ${nextOwner}`
          : `"${existing.title}" unassigned`;
        break;
      }
      case "set_due": {
        const iso =
          typeof body.dueAt === "string" && body.dueAt.length > 0
            ? new Date(body.dueAt).toISOString()
            : null;
        patch.due_at = iso;
        changeKind = "deadline_move";
        summary = iso
          ? `"${existing.title}" due ${new Date(iso).toLocaleDateString()}`
          : `Due date cleared on "${existing.title}"`;
        break;
      }
      case "defer": {
        if (!body.deferredUntil) {
          return NextResponse.json({ error: "deferredUntil required." }, { status: 400 });
        }
        const iso = new Date(body.deferredUntil).toISOString();
        patch.deferred_until = iso;
        if (typeof body.reason === "string") patch.decline_reason = body.reason.trim() || null;
        patch.pulse = "stale";
        changeKind = "commitment_stale";
        summary = `"${existing.title}" deferred until ${new Date(iso).toLocaleDateString()}${
          body.reason ? ` — ${body.reason}` : ""
        }`;
        break;
      }
      case "decline": {
        patch.status = "dropped";
        patch.pulse = "quiet";
        if (typeof body.reason === "string") patch.decline_reason = body.reason.trim() || null;
        changeKind = "scope_change";
        summary = `"${existing.title}" declined${body.reason ? ` — ${body.reason}` : ""}`;
        break;
      }
      case "scope_change": {
        patch.pulse = "tense";
        if (typeof body.reason === "string") patch.decline_reason = body.reason.trim() || null;
        changeKind = "scope_change";
        summary = `"${existing.title}" flagged: plan changed${
          body.reason ? ` — ${body.reason}` : ""
        }`;
        break;
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    const { error: updErr } = await auth.supabase
      .from("field_objects")
      .update(patch)
      .eq("id", body.id)
      .eq("team_space_id", team.id);
    if (updErr) throw updErr;

    const now = Date.now();
    await auth.supabase.from("change_events").insert({
      id: `chg-${now}`,
      team_space_id: team.id,
      kind: changeKind,
      summary,
      target_id: body.id,
      target_type: existing.type,
      source: "manual",
    });

    const state = await fetchLatticeState(auth.supabase, team.id);
    return NextResponse.json({ state, team });
  } catch (err) {
    console.error("/api/v2/commitment PATCH failed", err);
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }
}
