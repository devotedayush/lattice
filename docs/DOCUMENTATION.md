# Lattice — Technical Documentation

A working reference for anyone reading, extending, or debugging this codebase. Scope: what Lattice is, how it's wired, what the primitives mean, how the AI is prompted, and what every file does.

Written for someone who's seen a Next.js app before and wants the map fast.

---

## 1. What Lattice is

Lattice is an **AI-native team execution memory**. One screen's worth of pitch:

> You tell Lattice what's happening — by voice or by typing, in natural language. It interprets each update, turns it into structured state (commitments, blockers, assumptions, goal shifts, etc.), and holds a live model of the team. You ask it questions back and it answers from that model. It nudges you when commitments go stale or past due.

It is **not** a task tracker. Tickets and sprints are deliberately absent. The seven primitives (see §3) are the only operational vocabulary.

### What's unique
- Natural-language update → structured state, with the model operating in **Lattice's own voice** (see `lib/persona.ts`).
- A single **unified chat surface** for both ask ("what's at risk?") and tell ("Priya is blocked on auth"). Intent is classified client-side and routed.
- **Nudges** and **Morning Brief** are derived on read from the same state graph — no cron, no background job, no storage drift.
- **Member profiles + delivery stats** feed the AI context so owner suggestions reflect skills, current load, and historical on-time rate.

---

## 2. Stack and runtime

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | All routes under `app/`; pages and API in the same tree. |
| UI | React 19, CSS in `app/globals.css` | No design-system dep; inline styles where a one-off makes sense. |
| Language | TypeScript, strict | `tsc --noEmit` is the canonical check. |
| DB | Supabase (Postgres + RLS + Realtime) | Schema mutations via `mcp__supabase__apply_migration`. |
| Auth | Supabase email/password | JWT bearer tokens on every protected API route. |
| AI — text | OpenAI Chat Completions, `gpt-5.4-mini` default | See `OPENAI_MODEL`. Response-format JSON is used where the shape matters. |
| AI — audio | `gpt-4o-mini-transcribe` / `whisper-1` | See `OPENAI_TRANSCRIBE_MODEL`. |
| Realtime | Supabase postgres_changes channel | `lattice-{team_space_id}` subscribes to change_events, interventions, goals, field_objects; triggers a re-fetch in the client. |

### How requests flow

```
User → browser page (app/page.tsx)
  → fetch /api/... with `Authorization: Bearer <supabase JWT>`
  → requireUserSupabaseClient() validates token, returns an auth.supabase client bound to that user
  → handler calls into lib/* for business logic and/or OpenAI
  → response shaped to { state | interpretation | nudges | brief | ... }
  ← browser updates React state; Realtime subscription also re-fetches on DB change
```

---

## 3. The ontology (the seven primitives)

Every field object in Lattice is exactly one of these types (`FieldObjectType` in `lib/lattice.ts`). Tooltips in the UI and the `APP_KNOWLEDGE` prompt in `lib/persona.ts` both point at this table. If you change it here, change it there.

| Type | What it is | Example | Has |
|---|---|---|---|
| **intent** | What the team is trying to do — a direction, not a task. | "Ship a demo people trust by Friday." | title, detail |
| **promise** (labelled "Commitment" in UI) | A concrete thing someone agreed to deliver. | "Demo video — know2, due Fri, 80% confidence." | owner, status, dueAt, confidence |
| **blocker** | Something stopping progress. Open until resolved or dropped. | "Vendor API is down — Priya." | owner, status |
| **request** | An ask from one person to another, not yet accepted. | "Ask legal to review the data policy." | target, state (draft/sent/acknowledged/resolved/denied) |
| **reminder** | A self-nudge tied to a time/trigger. Not a commitment to anyone. | "Remind me at 8pm to retry the deploy." | trigger |
| **shift** | A direction or scope pivot — what the team was doing has changed. | "Dropping analytics — focus is the demo." | — |
| **signal** | A weak observation worth remembering but not yet actionable. | "Legal has been quiet for two weeks." | — |

### Confidence ≠ progress
The number shown on a commitment is **Lattice's confidence the work will land**, not a % done. UI labels it "conf". Default when unstated is `0.7`. Blockers typically start lower.

---

## 4. Views (the UI tree)

The app has one page (`app/page.tsx`) with tab-switched surfaces:

### Topbar
- Brand, team switcher, "Load demo" button (plants a full fictional team story — be aware this seeds names like "Diego" you'll then see in answers), user email, sign-out.

### Tabs
- **Pulse** — default landing.
  - Hero: active goal + goal-confidence sparkline.
  - `StatusBar` — risk and blocker dots, color only when non-zero.
  - `MyProfile` — editable name, skills, focus, notes; shows your own delivery stats inline.
  - `MorningBrief` — what changed / at risk / needs decision (3 bullets each, generated by `/api/v2/brief`).
  - `Nudges` — check-ins Lattice would send; each has Reply (pre-fills the chat) and Snooze (session-only).
  - `LatticeChat` — the unified chat. Mic + text input. Sends to `/api/v2/ask` for questions, `/api/v2/interpret` for statements.
  - Recent timeline, interventions, tensions.
- **Timeline** — full log of `change_events`, most recent first.
- **Interventions** — Lattice's suggested next actions, with Dismiss / Mark acted.
- **Commitments** — grouped by type; sorted inside each group by due date (overdue first). Rows expose Done/Resolve/Set-due/Can't-do/Drop and an owner-reassignment picker.

### Floating orb
A single floating button bottom-right. Click →
1. Switch to Pulse tab if elsewhere.
2. Scroll the chat into view.
3. Auto-start microphone recording.

Everything funnels through the one chat surface — the orb is not a separate composer any more.

---

## 5. Data model

All tables live in the `public` schema. RLS is on for everything.

### Core team objects
- **`team_spaces`** — one row per team.
  - `id text` (slug-based), `name`, `active_intent`, `tensions text[]`, `broadcast text[]`, `created_by → auth.users`.
- **`team_members`** — membership row per (user, team).
  - `id text` (`m-<teamId>-<userSlice>`), `team_space_id`, `user_id → auth.users`, `name`, `role` (owner/admin/member), `skills text[]`, `focus text`, `bio text`.
- **`team_invitations`** — email-based invitations.
  - `token` (random, used in `/invite/[token]` accept flow), `state` (pending/accepted/revoked/expired), `role`, `expires_at` (default +7d).

### V1 surface — the field
- **`field_objects`** — the one big table for all seven primitives.
  - `type orgmind_object_type` enum.
  - `owner text` (matches `team_members.name` when set).
  - `status text` — free-form (`new`, `done`, `dropped`, `resolved`, custom).
  - `confidence numeric` (0..1, default 0.7).
  - `position_x / position_y` — legacy "spatial canvas" coords; not rendered in current UI but preserved.
  - `pulse text` — one of quiet/active/tense/stale/clear.
  - `links text[]`.
  - `due_at timestamptz`, `deferred_until timestamptz`, `decline_reason text` — added in `commitment_due_and_deferral` migration.
- **`memory_events`** — chronological memory feed.
- **`delegated_requests`** — `request` type broken out (has `target`, `ask`, `why`, `state`).
- **`reminders`** — self-nudges with `trigger` text and `resolved_at`.
- **`interpretations`** — raw log of every natural-language update sent in, with AI output stored.

### V2 graph
- **`goals`** — first-class goals, with `state` (active/paused/achieved/dropped/superseded), `confidence`, `previous_goal_id` for history.
- **`change_events`** — every meaningful transition: `goal_shift`, `scope_change`, `priority_change`, `deadline_move`, `owner_change`, `blocker_emerged`, `blocker_resolved`, `assumption_invalidated`, `confidence_change`, `commitment_added`, `commitment_completed`, `commitment_stale`.
- **`assumptions`** — statements the team is operating on (`holds` / `at_risk` / `invalidated` / `reconfirmed`).
- **`dependencies`** — explicit dependency links (currently unused in UI).
- **`confidence_signals`** — time-series of confidence readings against any target.
- **`interventions`** — AI-suggested actions, with `urgency` 1–5 and `state` (suggested/accepted/dismissed/acted).

### Migrations (in order)
1. `setup_orgmind_backend` — initial V1 schema.
2. `tighten_orgmind_demo_policies` — RLS hardening for the demo space.
3. `add_basic_orgmind_auth` — auth policies.
4. `lattice_v2_state_graph` — goals/change_events/assumptions/dependencies/confidence_signals/interventions.
5. `lattice_v2_teams_invitations_roles` — team_members, team_invitations, role-based policies.
6. `lattice_v2_realtime_publication` — adds tables to the realtime publication.
7. `commitment_due_and_deferral` — `due_at`, `deferred_until`, `decline_reason` on field_objects.
8. `team_member_profiles` — `skills`, `focus`, `bio` on team_members.

---

## 6. API surface

All routes require a Supabase JWT (via `requireUserSupabaseClient` from `lib/auth-server.ts`) unless noted.

### Chat and state

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v2/interpret` | Take a natural-language `input` and (if `apply: true`) write it to state. Returns `{ interpretation, state, team }`. |
| POST | `/api/v2/ask` | Answer a question about the team. Takes `query`, optional `history` (≤6 turns of `{role, content}`). Injects `LATTICE_PERSONA` + `APP_KNOWLEDGE` + state as system context. |
| POST | `/api/v2/brief` | Deterministic digest over state (last `sinceHours`, default 72). Returns `{ brief: { changed, atRisk, needsDecision }, generatedAt }`. OpenAI used only to polish bullets. |
| GET | `/api/v2/nudges?team=…` | Derive-on-read check-ins (see `lib/nudges.ts`). |
| GET | `/api/v2/state?team=…` | Fetch the current `LatticeState`. |
| POST | `/api/v2/analyze` | Re-run structural analysis → refresh interventions. |
| POST | `/api/transcribe` | Multipart `audio` → `{ text }`. Wraps OpenAI audio. |

### Mutations on specific entities

| Method | Route | Actions / body |
|---|---|---|
| PATCH | `/api/v2/commitment` | `action ∈ { complete, resolve, drop, set_confidence, set_owner, set_due, defer, decline, scope_change }`. Logs a `change_event`. Ownership-gated for `drop` and `set_owner`+friends. |
| POST | `/api/v2/goal` | Replace or edit the active goal. |
| PATCH | `/api/v2/intervention` | Accept / dismiss / mark-acted. |
| PATCH | `/api/v2/assumption` | Change an assumption's state; logs if invalidated. |

### Teams and membership

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v2/teams` | List teams the caller belongs to. |
| POST | `/api/v2/teams` | Create a team, owner = caller. |
| GET | `/api/v2/teams/[teamId]/members` | List members with email (requires `SUPABASE_SERVICE_ROLE_KEY` to enrich emails). |
| PATCH | `/api/v2/teams/[teamId]/members` | Admin-only: change a member's role. |
| DELETE | `/api/v2/teams/[teamId]/members?memberId=…` | Admin-only: remove a member. |
| PATCH | `/api/v2/teams/[teamId]/members/profile` | Self-edit: name (≤60), skills (≤20, ≤40 chars each), focus (≤200), bio (≤600). |
| GET | `/api/v2/teams/[teamId]/invites` | List invites. |
| POST | `/api/v2/teams/[teamId]/invites` | Admin-only: create invite. |
| DELETE | `/api/v2/teams/[teamId]/invites?inviteId=…` | Admin-only: revoke invite. |
| POST | `/api/v2/invitations/accept` | Accept an invite via token. |

### Demo helpers (leave off in production)
| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v2/demo-seed` | Wipe the team and plant a rich fictional story. Owners include hardcoded names (Diego, etc.) — be aware. |
| POST | `/api/v2/simulate-teammate` | Fabricate a teammate update. |

---

## 7. File-by-file map

### `app/`
- `app/page.tsx` — the entire client-side app. One file, ~2500 lines. Contains `Page`, `PulseView`, `CommitmentsView`, `CommitmentRow`, `LatticeChat`, `MyProfile`, `MorningBrief`, `Nudges`, `StatusBar`, plus all supporting bits (`DuePicker`, `RespondPopover`, `TypeInfoButton`, etc.).
- `app/layout.tsx` — root layout, font wiring, `app/globals.css` import.
- `app/globals.css` — design tokens (`--bg`, `--ink`, `--muted`, `--line`, `--accent`, etc.) and shared utility classes (`commitment`, `section`, `btn-primary`, etc.).
- `app/invite/[token]/page.tsx` — public invite-accept screen.
- `app/api/...` — see route table above.

### `lib/`
- `lib/supabase.ts` — factory for browser, user-server (with bearer token), server (default admin fallback), and admin-only (`createSupabaseServiceClient`) Supabase clients.
- `lib/auth-server.ts` — `requireUserSupabaseClient` wraps auth on every API route.
- `lib/teams.ts` — team CRUD, member CRUD, invite CRUD, profile update, `listTeamMembers` with admin email enrichment.
- `lib/lattice.ts` — V1 types (`FieldObject`, `InterpretationEntity`, `TeamState`), the shape-to-FieldObject converter, the deterministic fallback parser (`fallbackInterpretation`) used when OpenAI isn't available.
- `lib/team-state-db.ts` — V1 fetch + apply to Supabase (`fetchTeamState`, `applyInterpretationToDatabase`).
- `lib/v2.ts` — V2 types and helpers: `LatticeState`, `ChangeEvent`, `Goal`, `Assumption`, `Intervention`, `InterpretationV2`, `structuralAnalysis`, `goalDrift`, `teamConfidence`, `atRiskCount`, `accentForChangeKind`, `glyphForChangeKind`, `labelForChangeKind`, `formatRelative`.
- `lib/v2-db.ts` — V2 persistence: `fetchLatticeState`, `applyInterpretationV2ToDatabase`.
- `lib/ai-v2.ts` — the AI interpret pipeline. Builds the full system prompt (persona + rules + owner extraction + due-date extraction), the context block (goal, members with skills/focus/stats, commitments, assumptions, recent changes), calls OpenAI JSON mode, falls back to deterministic parsing.
- `lib/persona.ts` — `LATTICE_PERSONA` (the voice) and `APP_KNOWLEDGE` (the ontology + how-it-works crib). Shared by ask and interpret.
- `lib/member-stats.ts` — `statsForMember(state, name)` → `{ completed, openCount, overdueCount, declinedCount, onTimeRate, avgDeliveryHours }`. Pure function; used in the UI and piped into the AI context.
- `lib/nudges.ts` — `deriveNudges(state)` → prioritized check-ins. Four kinds: `overdue_commitment`, `stale_commitment`, `open_blocker`, `stale_assumption`, `overdue_reminder`. Respects `deferred_until`.
- `lib/ai.ts` — V1 OpenAI wrapper (legacy, kept for `fallbackInterpretation`).

### `supabase/`
- `supabase/schema.sql` — the SQL equivalent of the early migrations, kept as documentation.

### `docs/`
- `docs/DOCUMENTATION.md` — this file.
- `docs/suggestion.md`, `docs/suggestion2.md` — historical PM/founder critiques that shaped current priorities.

---

## 8. How the AI is prompted

### The persona (`lib/persona.ts`)
- Character: a seasoned chief of staff. Dry, economical, point-of-view grounded only in the state.
- Hard bans: "Sure", "Great question", "as an AI", hedging, emoji, exclamation points.
- Required: contractions, specific names/numbers, 2–4 sentences, willing to push back and say what's missing.

### The ontology reference (`APP_KNOWLEDGE`)
Short canonical description of the seven primitives (with one example each) and a map of how the app's tabs and features work. Injected as a separate system message in `/api/v2/ask`.

### The interpret pipeline (`lib/ai-v2.ts`)
System prompt has four parts, in this order:
1. Persona.
2. JSON schema Lattice must return (`reply`, `richReply`, `entities`, `changes`, optional `goalShift`, `assumptions`, `interventions`, `followUpQuestion`, `broadcast`, `confidenceImpact`).
3. Principles (how to classify updates as blockers, scope changes, etc.).
4. **Owner extraction rules** — the critical section:
   - If the input names a specific person, put that name in `owner` and **strip assignment phrasing from the title**.
   - "I / me / my / self" is not a specific assignment — leave owner empty.
   - Never default to the reporter. Never guess.
   - One person per entity; emit multiple entities for multi-assignment utterances.
5. **Due-date extraction** — resolve natural phrases ("by Friday", "tomorrow EOD") to ISO 8601 UTC. Don't invent a due date.

The **context block** carries:
- Active goal + confidence.
- `TEAM_MEMBERS` (name, role, skills, focus, plus summarized delivery stats) — so the AI can suggest owners with rationale.
- Last 10 commitments (type, title, owner, status, confidence).
- Open assumptions.
- 5 most recent change_events.
- Structural: overload, goal drift.

### The ask pipeline (`/api/v2/ask`)
System messages, in order:
1. Persona + rules for answering.
2. `APP_KNOWLEDGE`.
3. Current state (goal, commitments, blockers, assumptions, recent changes, structural).

Then prior chat turns (≤6, each ≤800 chars) for continuity. Temperature 0.6 — a touch warmer than the interpret call, for voice.

---

## 9. Environment variables

```
OPENAI_API_KEY=sk-...                     # required for AI; without it, fallback parsers are used
OPENAI_MODEL=gpt-5.4-mini                 # used by interpret, ask, brief
OPENAI_TRANSCRIBE_MODEL=whisper-1         # used by /api/transcribe

NEXT_PUBLIC_SUPABASE_URL=https://...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...         # client + RLS-scoped server calls
SUPABASE_SERVICE_ROLE_KEY=...             # optional; enables email enrichment on members, some admin paths

LATTICE_TEAM_SPACE_ID=demo-team-space     # default team for legacy endpoints; superseded by auth-derived teams
```

Env changes only take effect on server restart. Next.js does not hot-reload `.env.local`.

---

## 10. Running it

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, sign up / sign in. First landing creates a team or joins one via invite token.

Typecheck: `npx tsc --noEmit`
Lint: `npx eslint app lib`

---

## 11. Known quirks and things to know

- **"Load demo" plants fictional owners** (Diego, Priya, etc.). If Lattice references a "Diego" you don't have, someone hit that button. Cleanup is a SQL scrub on field_objects / interventions / change_events / delegated_requests matching the name.
- **Confidence is not progress.** If users are reading the % as "% done", that's a bug in the label, not the data. The UI labels it "conf".
- **Commitment_stale / stale detection** in the analyze route has historically parsed `f.pulse` as a date — pulse is not a date. Real stale detection now comes from change_event timestamps in `lib/nudges.ts`.
- **Owner matching is case-insensitive, string-based.** Renaming a member doesn't rewrite their owner string on existing commitments. Intentional — history is history. Reassignment is the fix.
- **No cron or push.** Nudges and briefs are derived on read. A Slack/email delivery layer is a real follow-up (see `docs/suggestion.md` / `suggestion2.md`).
- **Deferred items don't nudge.** A commitment with `deferred_until > now()` is skipped by every nudge kind.
- **Spatial canvas columns (`position_x`, `position_y`) are preserved but not rendered.** They exist because the V1 "Team Field" demo used them and they may be revived.

---

## 12. Extending Lattice

Common changes and where they go:

| I want to… | Touch… |
|---|---|
| Add a primitive | `FieldObjectType` in `lib/lattice.ts` + the DB enum `orgmind_object_type` + `typeDescription` / `typeExample` in `app/page.tsx` + `APP_KNOWLEDGE` in `lib/persona.ts` + the AI JSON schema in `lib/ai-v2.ts`. |
| Add a commitment action | `Action` union + `case` in `/api/v2/commitment/route.ts` + a button or UI surface in `CommitmentRow`. |
| Add a tab | `Tab` type in `app/page.tsx`, `<Tabs>` items, a new view component, and a matching endpoint if it reads server-side data. |
| Add an API endpoint | New folder under `app/api/...` with `route.ts`. Always start with `requireUserSupabaseClient`. Shape the response as `{ state, team, ... }` if the client needs to refresh. |
| Change the AI voice | Edit `LATTICE_PERSONA` in `lib/persona.ts`. Applies everywhere. |
| Change what Lattice "knows" about the app | Edit `APP_KNOWLEDGE` in `lib/persona.ts`. |
| Add a nudge trigger | New block in `deriveNudges` in `lib/nudges.ts`. Add a `kind` value to the `Nudge` union. |
| Add a member stat | `statsForMember` in `lib/member-stats.ts`, plus rendering in `MyProfile` / `ManageTeamModal`. |

Rules of thumb from the session history:
- **Never default owner to the reporter.** Leave empty if unstated.
- **Label percentages as what they are.** "conf" vs "%" vs "% on-time". Untitled numbers get misread as progress.
- **Destructive actions (drop, reassign, defer, decline) must pass ownership gating** both UI and server. See `/api/v2/commitment` for the canonical check.
- **Derive on read before you store.** Nudges, Morning Brief, and member stats all prove this pattern: simpler, no sync drift, trivially correct.
- **One voice everywhere.** Share `LATTICE_PERSONA`; don't write a second system prompt that diverges.
