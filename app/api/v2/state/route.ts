import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import { fetchLatticeState } from "@/lib/v2-db";

export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const url = new URL(request.url);
  const requested = url.searchParams.get("team");
  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, requested);
    if (!team) {
      return NextResponse.json({ state: null, team: null, teams: [] });
    }
    const state = await fetchLatticeState(auth.supabase, team.id);
    return NextResponse.json({ state, team });
  } catch (err) {
    console.error("/api/v2/state GET", err);
    return NextResponse.json({ error: "Failed to load state." }, { status: 500 });
  }
}
