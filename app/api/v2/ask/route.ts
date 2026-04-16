import { NextResponse } from "next/server";
import OpenAI from "openai";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { getUserActiveTeam } from "@/lib/teams";
import { atRiskCount, goalDrift, structuralAnalysis, teamConfidence } from "@/lib/v2";
import { fetchLatticeState } from "@/lib/v2-db";

// POST /api/v2/ask { query, teamId? }
//
// Answers a natural-language question using the team's current lattice state
// as context. This is what makes Lattice feel alive — you can ask it about
// the org instead of just feeding it updates.
export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { query?: string; teamId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const query = body.query?.trim();
  if (!query) return NextResponse.json({ error: "query required." }, { status: 400 });

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

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

    const systemPrompt = `You are Lattice — the live model of this team's state.

You answer questions about the team *using only the provided state*. You are concise, honest, and specific. Style rules:
- Plain English, no bullet lists unless listing things.
- Name people and commitments directly.
- If the answer genuinely isn't in the state, say so in one sentence — don't invent.
- If the state implies a risk the user didn't ask about but should know, add one short sentence at the end starting "Worth knowing: ".
- Never use words like "currently", "as an AI", "based on the provided data". Just answer.
- 2–4 sentences. Conversational, calm, slightly clipped. Like a chief of staff who's been paying attention.`;

    if (!process.env.OPENAI_API_KEY) {
      // Fallback without AI: deterministic mini-answer.
      const fallback = activeGoal
        ? `No OpenAI key set, so I can only reply with raw state: goal is "${activeGoal.title}", confidence ${Math.round(teamConfidence(state) * 100)}%, ${state.fieldObjects.filter((f) => f.type === "blocker").length} blockers open.`
        : "No goal set yet.";
      return NextResponse.json({ answer: fallback, state, team });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `State:\n\n${context}\n\nQuestion: ${query}` },
      ],
      temperature: 0.4,
    });
    const answer = completion.choices[0]?.message?.content?.trim() ?? "No response.";

    return NextResponse.json({ answer, state, team });
  } catch (err) {
    console.error("/api/v2/ask failed", err);
    return NextResponse.json({ error: "Ask failed." }, { status: 500 });
  }
}
