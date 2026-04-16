import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { applyInterpretationToDatabase, fetchTeamState, updateRequestStateInDatabase } from "@/lib/team-state-db";
import type { Interpretation, RequestState } from "@/lib/lattice";

export async function GET(request: Request) {
  try {
    const auth = await requireUserSupabaseClient(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const teamState = await fetchTeamState(undefined, auth.supabase);
    return NextResponse.json(teamState);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load team state." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireUserSupabaseClient(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = (await request.json()) as { input?: string; interpretation?: Interpretation };

    if (!body.input?.trim() || !body.interpretation) {
      return NextResponse.json({ error: "Missing input or interpretation." }, { status: 400 });
    }

    const teamState = await applyInterpretationToDatabase(body.input.trim(), body.interpretation, undefined, auth.supabase);
    return NextResponse.json(teamState);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not persist interpretation." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireUserSupabaseClient(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = (await request.json()) as { id?: string; state?: RequestState };

    if (!body.id || !body.state) {
      return NextResponse.json({ error: "Missing request id or state." }, { status: 400 });
    }

    const teamState = await updateRequestStateInDatabase(body.id, body.state, undefined, auth.supabase);
    return NextResponse.json(teamState);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update request state." },
      { status: 500 },
    );
  }
}
