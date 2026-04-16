import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { createTeam, listUserTeams } from "@/lib/teams";

export async function GET(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const teams = await listUserTeams(auth.supabase, auth.user.id);
    return NextResponse.json({ teams });
  } catch (err) {
    console.error("/api/v2/teams GET", err);
    return NextResponse.json({ error: "Failed to list teams." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "Team name required." }, { status: 400 });

  try {
    const team = await createTeam(auth.supabase, auth.user, name);
    return NextResponse.json({ team });
  } catch (err) {
    console.error("/api/v2/teams POST", err);
    return NextResponse.json({ error: "Failed to create team." }, { status: 500 });
  }
}
