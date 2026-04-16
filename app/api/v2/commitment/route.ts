import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import type { ChangeKind } from "@/lib/v2";
import { fetchLatticeState } from "@/lib/v2-db";

type Action = "complete" | "resolve" | "drop" | "set_confidence";

// PATCH /api/v2/commitment { id, action, confidence?, teamId? }
//
// Updates a field_object (promise/blocker) and logs a change event.
export async function PATCH(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { id?: string; action?: Action; confidence?: number; teamId?: string };
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
      .select("id, type, title, status, confidence")
      .eq("id", body.id)
      .eq("team_space_id", team.id)
      .maybeSingle();
    if (exErr) throw exErr;
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });

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
