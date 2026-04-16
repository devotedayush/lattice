import { NextResponse } from "next/server";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import { fetchLatticeState } from "@/lib/v2-db";

// POST /api/v2/demo-seed { teamId?, reset? }
//
// Wipes the team's lattice data (optionally) and loads a rich, realistic
// scenario so the product has something to "remember" during a live demo.
// Pre-dates events across the past week so the timeline looks lived-in.
export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { teamId?: string; reset?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // ok, defaults
  }
  const reset = body.reset !== false; // default true

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const tid = team.id;
    const s = auth.supabase;

    if (reset) {
      // Order matters because of FKs (dependencies don't hard-ref to field_objects
      // but we still clear them). We use eq(team_space_id) for each table.
      await Promise.all([
        s.from("change_events").delete().eq("team_space_id", tid),
        s.from("interventions").delete().eq("team_space_id", tid),
        s.from("assumptions").delete().eq("team_space_id", tid),
        s.from("confidence_signals").delete().eq("team_space_id", tid),
        s.from("dependencies").delete().eq("team_space_id", tid),
        s.from("field_objects").delete().eq("team_space_id", tid),
        s.from("memory_events").delete().eq("team_space_id", tid),
        s.from("delegated_requests").delete().eq("team_space_id", tid),
        s.from("reminders").delete().eq("team_space_id", tid),
        s.from("interpretations").delete().eq("team_space_id", tid),
      ]);
      // Goals last (self-FK via previous_goal_id)
      await s.from("goals").delete().eq("team_space_id", tid);
    }

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

    // 1. Active goal, set 6 days ago
    const goalId = `seed-goal-${now}`;
    await s.from("goals").insert({
      id: goalId,
      team_space_id: tid,
      title: "Ship a trustworthy demo for Friday's investor review",
      detail: "End-to-end walkthrough that doesn't break, clear narrative, real auth flow.",
      state: "active",
      priority: 1,
      confidence: 0.68,
      created_at: iso(6 * day),
      updated_at: iso(6 * day),
    });

    // 2. Field objects (commitments + blockers + a request)
    const commitments = [
      {
        id: `seed-fo-${now}-1`,
        type: "promise",
        title: "Auth patch lands before the dry run",
        detail: "Priya is wrapping token refresh edge cases.",
        owner: "Priya",
        status: "in_progress",
        confidence: 0.75,
        pulse: "active",
        x: 0,
        y: 0,
        links: [],
        created_at: iso(5 * day),
      },
      {
        id: `seed-fo-${now}-2`,
        type: "promise",
        title: "Onboarding walkthrough recorded",
        detail: "Marco is doing the voiceover pass today.",
        owner: "Marco",
        status: "in_progress",
        confidence: 0.6,
        pulse: "active",
        x: 0,
        y: 0,
        links: [],
        created_at: iso(4 * day),
      },
      {
        id: `seed-fo-${now}-3`,
        type: "promise",
        title: "Demo script final read-through",
        detail: "Needs a second pair of eyes by Thursday evening.",
        owner: "Sana",
        status: "in_progress",
        confidence: 0.45,
        pulse: "tense",
        x: 0,
        y: 0,
        links: [],
        created_at: iso(3 * day),
      },
      {
        id: `seed-fo-${now}-4`,
        type: "blocker",
        title: "Vendor billing API returning 502s intermittently",
        detail: "Started Tuesday. Vendor acknowledged, no ETA.",
        owner: "Diego",
        status: "open",
        confidence: 0.3,
        pulse: "tense",
        x: 0,
        y: 0,
        links: [],
        created_at: iso(2 * day),
      },
      {
        id: `seed-fo-${now}-5`,
        type: "blocker",
        title: "Legal still hasn't signed off on the data export flow",
        detail: "Sent Monday, no response.",
        owner: "Diego",
        status: "open",
        confidence: 0.4,
        pulse: "tense",
        x: 0,
        y: 0,
        links: [],
        created_at: iso(2 * day),
      },
      {
        id: `seed-fo-${now}-6`,
        type: "request",
        title: "Design needs the updated logo in SVG",
        detail: "For the demo intro slide.",
        owner: "Arun",
        status: "open",
        confidence: 0.7,
        pulse: "active",
        x: 0,
        y: 0,
        links: [],
        created_at: iso(1 * day),
      },
    ];

    await s.from("field_objects").insert(
      commitments.map((c) => ({
        id: c.id,
        team_space_id: tid,
        type: c.type,
        title: c.title,
        detail: c.detail,
        owner: c.owner,
        status: c.status,
        confidence: c.confidence,
        position_x: c.x,
        position_y: c.y,
        pulse: c.pulse,
        links: c.links,
      })),
    );

    // 3. Change events — a lived-in timeline
    const events = [
      {
        id: `seed-ch-${now}-1`,
        kind: "goal_shift",
        summary: "Goal set: Ship a trustworthy demo for Friday's investor review",
        created_at: iso(6 * day),
      },
      {
        id: `seed-ch-${now}-2`,
        kind: "commitment_added",
        summary: "Priya picked up the auth patch",
        created_at: iso(5 * day),
      },
      {
        id: `seed-ch-${now}-3`,
        kind: "commitment_added",
        summary: "Marco owns onboarding walkthrough",
        created_at: iso(4 * day),
      },
      {
        id: `seed-ch-${now}-4`,
        kind: "scope_change",
        summary: "Dropped analytics dashboard from demo scope",
        detail: "Too risky to demo. Not critical for Friday.",
        created_at: iso(3 * day + 2 * 60 * 60 * 1000),
      },
      {
        id: `seed-ch-${now}-5`,
        kind: "blocker_emerged",
        summary: "Vendor billing API returning 502s",
        detail: "Diego investigating. Vendor acknowledged but no ETA.",
        created_at: iso(2 * day),
      },
      {
        id: `seed-ch-${now}-6`,
        kind: "assumption_invalidated",
        summary: "Legal sign-off timing was optimistic",
        detail: "We assumed Monday turnaround. It's Wednesday with no response.",
        created_at: iso(1 * day + 3 * 60 * 60 * 1000),
      },
      {
        id: `seed-ch-${now}-7`,
        kind: "confidence_change",
        summary: "Overall demo confidence dropped to 68%",
        created_at: iso(8 * 60 * 60 * 1000),
      },
    ];
    await s.from("change_events").insert(
      events.map((e) => ({
        id: e.id,
        team_space_id: tid,
        kind: e.kind,
        summary: e.summary,
        detail: (e as { detail?: string }).detail ?? null,
        source: "seed",
        created_at: e.created_at,
      })),
    );

    // 4. Assumptions
    await s.from("assumptions").insert([
      {
        id: `seed-as-${now}-1`,
        team_space_id: tid,
        statement: "Legal will sign off on the data export flow by Wednesday",
        state: "invalidated",
        tied_to: goalId,
        last_checked_at: iso(1 * day),
      },
      {
        id: `seed-as-${now}-2`,
        team_space_id: tid,
        statement: "Vendor billing API is stable enough to demo against",
        state: "at_risk",
        tied_to: goalId,
        last_checked_at: iso(1 * day),
      },
      {
        id: `seed-as-${now}-3`,
        team_space_id: tid,
        statement: "Recording quality from Marco's setup is demo-ready",
        state: "holds",
        tied_to: goalId,
      },
    ]);

    // 5. Confidence signals — for the sparkline
    const signals = [
      { off: 6 * day, conf: 0.85 },
      { off: 5 * day, conf: 0.82 },
      { off: 4 * day, conf: 0.78 },
      { off: 3 * day, conf: 0.74 },
      { off: 2 * day, conf: 0.6 },
      { off: 1 * day, conf: 0.65 },
      { off: 4 * 60 * 60 * 1000, conf: 0.68 },
    ];
    await s.from("confidence_signals").insert(
      signals.map((sig, i) => ({
        id: `seed-sig-${now}-${i}`,
        team_space_id: tid,
        target_id: goalId,
        target_type: "goal",
        confidence: sig.conf,
        note: null,
        created_at: iso(sig.off),
      })),
    );

    // 6. Interventions — what Lattice would suggest right now
    await s.from("interventions").insert([
      {
        id: `seed-int-${now}-1`,
        team_space_id: tid,
        title: "Escalate legal sign-off today",
        rationale: "The assumption broke yesterday. Every hour it sits makes the Friday ship riskier.",
        action_kind: "escalate",
        urgency: 5,
        target_type: "assumption",
        state: "suggested",
      },
      {
        id: `seed-int-${now}-2`,
        team_space_id: tid,
        title: "Have a fallback for the vendor API in the demo path",
        rationale: "502s are intermittent. If it fails mid-demo, we need a mock or cached response ready.",
        action_kind: "mitigate",
        urgency: 4,
        target_type: "blocker",
        state: "suggested",
      },
      {
        id: `seed-int-${now}-3`,
        team_space_id: tid,
        title: "Reshuffle load on Diego",
        rationale: "Diego is carrying both open blockers. Pair someone on the legal chase so he can focus on the vendor issue.",
        action_kind: "rebalance",
        urgency: 3,
        target_type: "owner",
        state: "suggested",
      },
    ]);

    // 7. Update team_spaces.active_intent so Pulse has context even without goal lookup
    await s.from("team_spaces").update({
      active_intent: "Ship a trustworthy demo for Friday's investor review",
      tensions: [
        "Legal sign-off is late and nobody's chasing",
        "Vendor API reliability — demo depends on it",
      ],
    }).eq("id", tid);

    const state = await fetchLatticeState(s, tid);
    return NextResponse.json({ state, team });
  } catch (err) {
    console.error("/api/v2/demo-seed failed", err);
    return NextResponse.json({ error: "Seed failed." }, { status: 500 });
  }
}
