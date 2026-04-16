import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import type { InterventionState } from "@/lib/v2";
import { updateInterventionState } from "@/lib/v2-db";

const allowed: InterventionState[] = ["suggested", "accepted", "dismissed", "acted"];

export async function PATCH(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { id?: string; state?: InterventionState; teamId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.id || !body.state || !allowed.includes(body.state)) {
    return NextResponse.json({ error: "id and valid state required." }, { status: 400 });
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });
    const state = await updateInterventionState(auth.supabase, body.id, body.state, team.id);
    return NextResponse.json({ state, team });
  } catch (err) {
    console.error("/api/v2/intervention PATCH failed", err);
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }
}
