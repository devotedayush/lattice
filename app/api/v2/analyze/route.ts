import { NextResponse } from "next/server";
import OpenAI from "openai";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import { goalDrift, structuralAnalysis, type LatticeState } from "@/lib/v2";
import { fetchLatticeState } from "@/lib/v2-db";

// Use one GPT call to classify each commitment vs. the active goal as
// aligned / drifting / unsure. Returns the drifting commitment IDs. If GPT
// is unavailable, returns empty (caller falls back to keyword-based drift).
async function aiGoalAlignment(state: LatticeState): Promise<string[]> {
  const goal = state.goals.find((g) => g.state === "active");
  const commitments = state.fieldObjects.filter((f) => f.type === "promise");
  if (!goal || commitments.length === 0 || !process.env.OPENAI_API_KEY) return [];

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const list = commitments.map((c) => `${c.id}: ${c.title} — ${c.detail}`).join("\n");
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content:
            "You classify commitments against a team's active goal. For each commitment, decide whether it clearly ladders up to the goal. Reply ONLY with a JSON object: { \"drifting\": [\"id1\", \"id2\"] } — list the IDs that DO NOT ladder up. No prose.",
        },
        {
          role: "user",
          content: `Goal: ${goal.title}\n${goal.detail ? `Detail: ${goal.detail}\n` : ""}\nCommitments:\n${list}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { drifting?: string[] };
    return Array.isArray(parsed.drifting) ? parsed.drifting : [];
  } catch {
    return [];
  }
}

// POST /api/v2/analyze { teamId? }
//
// Runs structural + drift signals over the current lattice state and
// inserts any missing "suggested" interventions. Deduplicated against
// open suggestions (by title). Returns the refreshed lattice state and
// the list of newly-created interventions.
export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { teamId?: string } = {};
  try {
    body = (await request.json()) as { teamId?: string };
  } catch {
    // empty body is fine
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const state = await fetchLatticeState(auth.supabase, team.id);

    const openTitles = new Set(
      state.interventions
        .filter((iv) => iv.state === "suggested" || iv.state === "accepted")
        .map((iv) => iv.title.toLowerCase().trim()),
    );

    const candidates: Array<{
      title: string;
      rationale: string;
      actionKind: string;
      urgency: number;
      targetType?: string;
    }> = [];

    // Goal drift — prefer AI alignment, fall back to keyword heuristic
    const aiDriftIds = await aiGoalAlignment(state);
    const drift = goalDrift(state);
    const driftingIds = aiDriftIds.length
      ? aiDriftIds
      : drift.driftingCommitments.map((c) => c.id);
    if (driftingIds.length >= 2) {
      const titles = state.fieldObjects
        .filter((f) => driftingIds.includes(f.id))
        .map((f) => `"${f.title}"`)
        .slice(0, 3)
        .join(", ");
      candidates.push({
        title: "Re-anchor drifting commitments to the goal",
        rationale: `${driftingIds.length} commitments don't clearly ladder up to the active goal (${titles}). Either re-frame them or drop them.`,
        actionKind: "realign",
        urgency: 4,
        targetType: "goal",
      });
    }

    // Overloaded owners
    const struct = structuralAnalysis(state);
    for (const { owner, count } of struct.overloaded) {
      if (owner === "Unassigned") {
        candidates.push({
          title: `Assign owners on ${count} unowned blockers`,
          rationale: "Blockers without owners tend to sit. Name someone on each.",
          actionKind: "assign",
          urgency: 3,
          targetType: "blocker",
        });
      } else {
        candidates.push({
          title: `Reshuffle load on ${owner}`,
          rationale: `${owner} is carrying ${count} open blockers. Someone else should pick one up.`,
          actionKind: "rebalance",
          urgency: 3,
          targetType: "owner",
        });
      }
    }

    // Recurring blocker tokens → likely structural issue
    for (const { token, count } of struct.recurring.slice(0, 2)) {
      candidates.push({
        title: `Address recurring theme: "${token}"`,
        rationale: `"${token}" is showing up across ${count} blockers. That's a pattern, not ${count} separate problems.`,
        actionKind: "investigate",
        urgency: 3,
        targetType: "pattern",
      });
    }

    // Stale commitments (created > 7d ago, still active, confidence < 0.6)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stale = state.fieldObjects.filter(
      (f) =>
        f.type === "promise" &&
        f.confidence < 0.6 &&
        Date.parse(f.pulse ?? "") < weekAgo,
    );
    if (stale.length) {
      candidates.push({
        title: `Check in on ${stale.length} stale commitment${stale.length > 1 ? "s" : ""}`,
        rationale: `Low-confidence commitments that haven't moved in over a week. Ask: still real, or quietly dropped?`,
        actionKind: "check_in",
        urgency: 2,
        targetType: "promise",
      });
    }

    // At-risk assumptions
    const atRiskAssum = state.assumptions.filter((a) => a.state === "at_risk");
    if (atRiskAssum.length) {
      candidates.push({
        title: `Validate ${atRiskAssum.length} at-risk assumption${atRiskAssum.length > 1 ? "s" : ""}`,
        rationale: "These were flagged as shaky. Confirm or kill them before the plan depends on them further.",
        actionKind: "validate",
        urgency: 4,
        targetType: "assumption",
      });
    }

    const toInsert = candidates.filter((c) => !openTitles.has(c.title.toLowerCase().trim()));
    if (toInsert.length) {
      const now = Date.now();
      const rows = toInsert.map((c, i) => ({
        id: `int-auto-${now}-${i}`,
        team_space_id: team.id,
        title: c.title,
        rationale: c.rationale,
        action_kind: c.actionKind,
        urgency: c.urgency,
        target_type: c.targetType ?? null,
        state: "suggested" as const,
      }));
      const { error } = await auth.supabase.from("interventions").insert(rows);
      if (error) throw error;
    }

    const nextState = await fetchLatticeState(auth.supabase, team.id);
    return NextResponse.json({ state: nextState, team, added: toInsert.length });
  } catch (err) {
    console.error("/api/v2/analyze failed", err);
    return NextResponse.json({ error: "Analyze failed." }, { status: 500 });
  }
}
