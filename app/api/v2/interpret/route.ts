import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { interpretV2 } from "@/lib/ai-v2";
import { getUserActiveTeam, listTeamMembers } from "@/lib/teams";
import { applyInterpretationV2ToDatabase, fetchLatticeState } from "@/lib/v2-db";

export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { input?: string; apply?: boolean; teamId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "Input is required." }, { status: 400 });
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team — create one first." }, { status: 400 });

    const [currentState, members] = await Promise.all([
      fetchLatticeState(auth.supabase, team.id),
      listTeamMembers(auth.supabase, team.id).catch(() => []),
    ]);
    const interpretation = await interpretV2(input, currentState, members);

    if (!body.apply) {
      return NextResponse.json({ interpretation, state: currentState, team });
    }

    const nextState = await applyInterpretationV2ToDatabase(auth.supabase, {
      input,
      interpretation,
      teamSpaceId: team.id,
    });
    return NextResponse.json({ interpretation, state: nextState, team });
  } catch (err) {
    console.error("/api/v2/interpret failed", err);
    return NextResponse.json({ error: "Interpretation failed." }, { status: 500 });
  }
}
