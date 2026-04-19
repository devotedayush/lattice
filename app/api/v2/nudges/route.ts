import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { deriveNudges } from "@/lib/nudges";
import { getUserActiveTeam } from "@/lib/teams";
import { fetchLatticeState } from "@/lib/v2-db";

// GET /api/v2/nudges?team=...
//
// Derived on read — pure function over current state. No storage, no cron.
// Returns the check-ins Lattice would push to people right now.
export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const teamId = url.searchParams.get("team");

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, teamId);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const state = await fetchLatticeState(auth.supabase, team.id);
    const nudges = deriveNudges(state).slice(0, 6);
    return NextResponse.json({ nudges, team });
  } catch (err) {
    console.error("/api/v2/nudges failed", err);
    return NextResponse.json({ error: "Nudges failed." }, { status: 500 });
  }
}
