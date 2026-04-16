import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import { fetchLatticeState } from "@/lib/v2-db";

// POST /api/v2/goal { title, detail?, confidence?, mode?: 'replace'|'adjust', teamId? }
//
// Sets a new active goal. If one exists, supersedes it (replace by default).
export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: {
    title?: string;
    detail?: string;
    confidence?: number;
    mode?: "replace" | "adjust";
    teamId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "title required." }, { status: 400 });

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const { data: currentActive } = await auth.supabase
      .from("goals")
      .select("id")
      .eq("team_space_id", team.id)
      .eq("state", "active")
      .limit(1)
      .maybeSingle();

    if (currentActive) {
      await auth.supabase.from("goals").update({ state: "superseded" }).eq("id", currentActive.id);
    }

    const now = Date.now();
    const newGoalId = `goal-${now}`;
    const confidence = typeof body.confidence === "number" ? body.confidence : 0.7;

    const { error: insertErr } = await auth.supabase.from("goals").insert({
      id: newGoalId,
      team_space_id: team.id,
      title,
      detail: body.detail ?? null,
      state: "active",
      priority: 1,
      confidence,
      previous_goal_id: currentActive?.id ?? null,
    });
    if (insertErr) throw insertErr;

    await auth.supabase.from("change_events").insert({
      id: `chg-${now}`,
      team_space_id: team.id,
      kind: "goal_shift",
      summary: currentActive ? `Goal reset: ${title}` : `Goal set: ${title}`,
      detail: body.detail ?? null,
      target_id: newGoalId,
      target_type: "goal",
      source: "manual",
    });

    const state = await fetchLatticeState(auth.supabase, team.id);
    return NextResponse.json({ state, team });
  } catch (err) {
    console.error("/api/v2/goal POST failed", err);
    return NextResponse.json({ error: "Set goal failed." }, { status: 500 });
  }
}

// PATCH /api/v2/goal { id, state?, confidence?, title?, detail?, teamId? }
export async function PATCH(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: {
    id?: string;
    state?: "active" | "paused" | "achieved" | "dropped";
    confidence?: number;
    title?: string;
    detail?: string;
    teamId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id required." }, { status: 400 });

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (body.state) patch.state = body.state;
    if (typeof body.confidence === "number") patch.confidence = body.confidence;
    if (body.title) patch.title = body.title;
    if (body.detail !== undefined) patch.detail = body.detail;

    const { error } = await auth.supabase
      .from("goals")
      .update(patch)
      .eq("id", body.id)
      .eq("team_space_id", team.id);
    if (error) throw error;

    const state = await fetchLatticeState(auth.supabase, team.id);
    return NextResponse.json({ state, team });
  } catch (err) {
    console.error("/api/v2/goal PATCH failed", err);
    return NextResponse.json({ error: "Update goal failed." }, { status: 500 });
  }
}
