import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { interpretV2 } from "@/lib/ai-v2";
import { getUserActiveTeam } from "@/lib/teams";
import { applyInterpretationV2ToDatabase, fetchLatticeState } from "@/lib/v2-db";

// A small bank of realistic teammate updates the demo can fire to show
// the state graph reacting in real time.
const SCENARIOS: Array<{ who: string; say: string }> = [
  {
    who: "Priya",
    say: "Heads up — the vendor API we were counting on pushed a breaking change. I can patch around it but we lose two days on the pricing rollout.",
  },
  {
    who: "Marco",
    say: "Finished the onboarding revamp. Dropping the old flow tomorrow unless anyone objects.",
  },
  {
    who: "Sana",
    say: "Legal just flagged that the new data export needs a DPA before we ship. That assumption about 'no legal review' is dead.",
  },
  {
    who: "Diego",
    say: "I'm overloaded. If I keep both the migration and the dashboard work, one of them slips by a week.",
  },
  {
    who: "Arun",
    say: "Customer from the Thursday call said they'd churn if we don't fix the billing lag. That changes priority order.",
  },
];

// POST /api/v2/simulate-teammate { teamId?, scenarioIndex? }
export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { teamId?: string; scenarioIndex?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // ignore
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const idx =
      typeof body.scenarioIndex === "number"
        ? ((body.scenarioIndex % SCENARIOS.length) + SCENARIOS.length) % SCENARIOS.length
        : Math.floor(Math.random() * SCENARIOS.length);
    const scenario = SCENARIOS[idx];
    const input = `${scenario.who} says: ${scenario.say}`;

    const currentState = await fetchLatticeState(auth.supabase, team.id);
    const interpretation = await interpretV2(input, currentState);
    const state = await applyInterpretationV2ToDatabase(auth.supabase, {
      input,
      interpretation,
      teamSpaceId: team.id,
    });

    return NextResponse.json({ scenario, interpretation, state, team });
  } catch (err) {
    console.error("/api/v2/simulate-teammate failed", err);
    return NextResponse.json({ error: "Simulate failed." }, { status: 500 });
  }
}
