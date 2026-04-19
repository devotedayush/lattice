import { NextResponse } from "next/server";
import OpenAI from "openai";

import { requireUserSupabaseClient } from "@/lib/auth-server";
import { LATTICE_PERSONA } from "@/lib/persona";
import { getUserActiveTeam } from "@/lib/teams";
import {
  atRiskCount,
  goalDrift,
  structuralAnalysis,
  teamConfidence,
  type LatticeState,
} from "@/lib/v2";
import { fetchLatticeState } from "@/lib/v2-db";

type Brief = {
  changed: string[];
  atRisk: string[];
  needsDecision: string[];
};

// POST /api/v2/brief { teamId?, sinceHours? }
//
// Morning brief: three short lists the reader can scan in 30 seconds —
// what changed, what's at risk, what needs a decision. Deterministic core
// so the demo is reliable; OpenAI only rewrites bullets if available.
export async function POST(request: Request) {
  const auth = await requireUserSupabaseClient(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { teamId?: string; sinceHours?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }

  try {
    const team = await getUserActiveTeam(auth.supabase, auth.user.id, body.teamId ?? null);
    if (!team) return NextResponse.json({ error: "No team." }, { status: 400 });

    const state = await fetchLatticeState(auth.supabase, team.id);
    const sinceHours = Math.max(1, Math.min(24 * 14, body.sinceHours ?? 72));
    const raw = buildBrief(state, sinceHours);

    let brief = raw;
    if (process.env.OPENAI_API_KEY && hasAnyBullets(raw)) {
      brief = await refineWithAI(raw, state).catch(() => raw);
    }

    return NextResponse.json({
      brief,
      generatedAt: new Date().toISOString(),
      sinceHours,
      team,
    });
  } catch (err) {
    console.error("/api/v2/brief failed", err);
    return NextResponse.json({ error: "Brief failed." }, { status: 500 });
  }
}

function hasAnyBullets(b: Brief): boolean {
  return b.changed.length + b.atRisk.length + b.needsDecision.length > 0;
}

function buildBrief(state: LatticeState, sinceHours: number): Brief {
  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;

  // What changed — recent change_events within window, deduped by summary.
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const ev of state.changeEvents) {
    const ts = Date.parse(ev.createdAt);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const key = ev.summary.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    changed.push(ev.summary);
    if (changed.length >= 3) break;
  }

  // At risk — open blockers, low-confidence commitments, invalidated assumptions.
  const atRisk: string[] = [];
  const openBlockers = state.fieldObjects.filter(
    (f) => f.type === "blocker" && f.status !== "resolved" && f.status !== "dropped",
  );
  for (const b of openBlockers.slice(0, 2)) {
    atRisk.push(`Blocker: ${b.title}${b.owner ? ` (${b.owner})` : ""}`);
  }
  const wobbly = state.fieldObjects
    .filter(
      (f) =>
        f.type === "promise" &&
        f.status !== "done" &&
        f.status !== "dropped" &&
        f.confidence < 0.5,
    )
    .sort((a, b) => a.confidence - b.confidence);
  for (const w of wobbly.slice(0, 2)) {
    atRisk.push(
      `${w.title}${w.owner ? ` (${w.owner})` : ""} — ${Math.round(w.confidence * 100)}% confidence`,
    );
  }
  const broken = state.assumptions.filter(
    (a) => a.state === "at_risk" || a.state === "invalidated",
  );
  for (const a of broken.slice(0, 2)) {
    atRisk.push(`Assumption ${a.state.replace("_", " ")}: ${a.statement}`);
  }
  const struct = structuralAnalysis(state);
  for (const o of struct.overloaded.slice(0, 1)) {
    atRisk.push(`${o.owner} is carrying ${o.count} blockers`);
  }
  const drift = goalDrift(state);
  if (drift.driftingCommitments.length > 0) {
    atRisk.push(
      `${drift.driftingCommitments.length} commitment${
        drift.driftingCommitments.length === 1 ? "" : "s"
      } drifting from the active goal`,
    );
  }

  // Needs decision — high-urgency suggested interventions + goal at low confidence.
  const needsDecision: string[] = [];
  const suggested = state.interventions
    .filter((i) => i.state === "suggested")
    .sort((a, b) => b.urgency - a.urgency);
  for (const iv of suggested.slice(0, 3)) {
    needsDecision.push(iv.title);
  }
  const activeGoal = state.goals.find((g) => g.state === "active");
  const conf = teamConfidence(state);
  if (activeGoal && conf < 0.4 && needsDecision.length < 3) {
    needsDecision.push(
      `Goal "${activeGoal.title}" at ${Math.round(conf * 100)}% — reconfirm or re-scope?`,
    );
  }
  if (atRiskCount(state) >= 4 && needsDecision.length < 3) {
    needsDecision.push(`${atRiskCount(state)} commitments at risk — triage this morning`);
  }

  return {
    changed: changed.slice(0, 3),
    atRisk: atRisk.slice(0, 3),
    needsDecision: needsDecision.slice(0, 3),
  };
}

async function refineWithAI(raw: Brief, state: LatticeState): Promise<Brief> {
  const activeGoal = state.goals.find((g) => g.state === "active");
  const context = [
    `Goal: ${activeGoal?.title ?? "—"}`,
    `Team confidence: ${Math.round(teamConfidence(state) * 100)}%`,
    `Open blockers: ${state.fieldObjects.filter((f) => f.type === "blocker").length}`,
  ].join("\n");

  const system = `${LATTICE_PERSONA}

You are writing the reader's 7am brief. Rewrite the provided bullets into punchy one-liners — your voice, but terse.

Rules:
- Preserve meaning. Do not invent facts not in the input or context.
- Each bullet ≤90 characters.
- Name people, goals, blockers directly. Never "the team", "stakeholders", "some items".
- Past tense for "changed"; present for "at risk" and "needs decision".
- No bullet can start with "The", "A", or "There". Start with a noun, name, or verb.
- Return JSON: { "changed": string[], "atRisk": string[], "needsDecision": string[] } with the same counts as input.`;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Context:\n${context}\n\nInput bullets:\n${JSON.stringify(raw, null, 2)}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });
  const content = completion.choices[0]?.message.content;
  if (!content) return raw;
  const parsed = JSON.parse(content) as Partial<Brief>;
  return {
    changed: Array.isArray(parsed.changed) ? parsed.changed.slice(0, 3) : raw.changed,
    atRisk: Array.isArray(parsed.atRisk) ? parsed.atRisk.slice(0, 3) : raw.atRisk,
    needsDecision: Array.isArray(parsed.needsDecision)
      ? parsed.needsDecision.slice(0, 3)
      : raw.needsDecision,
  };
}
