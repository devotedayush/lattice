import { NextResponse } from "next/server";
import OpenAI from "openai";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { APP_KNOWLEDGE, LATTICE_PERSONA } from "@/lib/persona";
import { getUserActiveTeam } from "@/lib/teams";
import { atRiskCount, goalDrift, structuralAnalysis, teamConfidence } from "@/lib/v2";
import { fetchLatticeState } from "@/lib/v2-db";

// POST /api/v2/ask { query, teamId? }
//
// Answers a natural-language question using the team's current lattice state
// as context. This is what makes Lattice feel alive — you can ask it about
// the org instead of just feeding it updates.
export async function POST(request: Request) {
  // Track which stage is running so a 500 can name the culprit instead of
  // collapsing to a generic "Ask failed." — otherwise prod triage is guesswork.
  let stage: "auth" | "body" | "team" | "state" | "openai" | "unknown" = "auth";

  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error, stage: "auth" }, { status: auth.status });

  type HistoryTurn = { role: "user" | "assistant"; content: string };
  let body: { query?: string; teamId?: string; history?: HistoryTurn[] };
  stage = "body";
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON.", stage }, { status: 400 });
  }
  const query = body.query?.trim();
  if (!query) return NextResponse.json({ error: "query required.", stage }, { status: 400 });

  // Short rolling window — enough for follow-ups ("why?", "what about him?"),
  // not enough to drift into a ChatGPT thread.
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (t) =>
            t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content.trim().length > 0,
        )
        .slice(-6)
        .map((t) => ({ role: t.role, content: t.content.slice(0, 800) }))
    : [];

  try {
    stage = "team";
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team.", stage }, { status: 400 });

    stage = "state";
    const state = await fetchLatticeState(auth.supabase, team.id);
    const activeGoal = state.goals.find((g) => g.state === "active");
    const drift = goalDrift(state);
    const struct = structuralAnalysis(state);

    // Compact context block — keep tokens lean.
    const context = [
      `Active goal: ${activeGoal?.title ?? "none"}${activeGoal?.detail ? ` — ${activeGoal.detail}` : ""}`,
      `Team confidence: ${Math.round(teamConfidence(state) * 100)}% · at-risk commitments: ${atRiskCount(state)} · open blockers: ${state.fieldObjects.filter((f) => f.type === "blocker").length}`,
      "",
      "Commitments (promises):",
      ...state.fieldObjects
        .filter((f) => f.type === "promise")
        .map((f) => `- ${f.title} — ${f.owner ?? "unassigned"} · ${Math.round(f.confidence * 100)}% · ${f.status ?? ""}`),
      "",
      "Blockers:",
      ...state.fieldObjects
        .filter((f) => f.type === "blocker")
        .map((f) => `- ${f.title} — ${f.owner ?? "unassigned"} · ${f.status ?? ""} — ${f.detail}`),
      "",
      "Assumptions:",
      ...state.assumptions.map((a) => `- [${a.state}] ${a.statement}`),
      "",
      "Recent changes (most recent first):",
      ...state.changeEvents.slice(0, 8).map((c) => `- ${c.kind}: ${c.summary}`),
      "",
      `Structural: ${struct.overloaded.length ? `overloaded: ${struct.overloaded.map((o) => `${o.owner}(${o.count})`).join(", ")}` : "no overload"} · ${drift.driftingCommitments.length} commitments drifting from goal`,
    ].join("\n");

    const systemPrompt = `${LATTICE_PERSONA}

You are answering a direct question from a teammate. Use only the state provided below — never invent people, commitments, or dates. If the state doesn't answer the question, say that in one sentence.

Prior turns in this conversation are included for continuity so follow-ups like "why?", "what about them?", or "and the other one?" resolve correctly. Do not restate earlier answers. If the new question doesn't reference the prior thread, ignore the history.`;

    if (!process.env.OPENAI_API_KEY) {
      // Deterministic fallback without AI — still in voice.
      const blockers = state.fieldObjects.filter((f) => f.type === "blocker").length;
      const fallback = activeGoal
        ? `Goal is "${activeGoal.title}". Confidence ${Math.round(teamConfidence(state) * 100)}%, ${blockers} open blocker${blockers === 1 ? "" : "s"}. Wire up an OpenAI key and I'll stop reading you the raw numbers.`
        : "No goal is set. Hard to have a point of view on a team that hasn't said what it's doing.";
      return NextResponse.json({ answer: fallback, state, team });
    }

    stage = "openai";
    const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "system", content: APP_KNOWLEDGE },
        { role: "system", content: `Current state (source of truth):\n\n${context}` },
        ...history,
        { role: "user", content: query },
      ],
      temperature: 0.6,
    });
    const answer = completion.choices[0]?.message?.content?.trim() ?? "Nothing to say on that.";

    return NextResponse.json({ answer, state, team });
  } catch (err) {
    console.error(`/api/v2/ask failed at stage=${stage}`, err);
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : "unknown error";
    // OpenAI SDK errors carry a numeric `status` we can pass through for clarity.
    const upstreamStatus =
      typeof err === "object" && err && "status" in err && typeof (err as { status: unknown }).status === "number"
        ? ((err as { status: number }).status)
        : undefined;
    return NextResponse.json(
      {
        error: `Ask failed at ${stage}: ${detail}`,
        stage,
        upstreamStatus,
      },
      { status: 500 },
    );
  }
}
