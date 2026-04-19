# Lattice

## Inspiration

I run a startup and a small agency at the same time. Between the two I'm juggling somewhere around fifteen people across two very different contexts, and I am — by necessity, not by title — the HR person, the PM, the chief-of-staff, and the person who remembers who promised what to whom. The memory burden alone is ridiculous.

Every tool I've tried to outsource that memory to has felt **dead on arrival**. Linear is a ticket graveyard. Notion rots the moment two people stop agreeing on the folder structure. Slack is a firehose. Jira is Jira. They store what happened; none of them _understand_ what's happening.

What I actually wanted was an **AI-native tool that behaves like a quiet chief of staff who's been paying attention.** Something that:

1. Replaces the need for HR-style follow-ups — "hey, how's that going? Are you still blocked? Who's owning this?"
2. Is more intuitive than a Kanban board, because most of my week isn't shaped like tickets — it's shaped like _promises_, _blockers_, _shifts in direction_, and _weak signals that something's off_.
3. Understands where the company is actually headed and can tell me when execution has drifted from stated intent.
4. **Surfaces what I, as the founder, am missing.** The single thing I care most about — because I already see what's in front of me; I need help with what isn't.

Lattice is my attempt at that tool.

## What it does

Lattice is an **AI-native team execution memory**. You tell it what's happening in natural language (voice or text) and it:

1. **Interprets** the update and turns it into structured state — a commitment, a blocker, a request, an assumption, a direction shift.
2. **Holds a live model** of the team: active goal, open commitments per person, blockers, assumptions, confidence over time.
3. **Nudges** specific people when commitments go past their deadline, blockers sit unowned, or assumptions haven't been revisited.
4. **Answers questions** from that model in a single voice — the seasoned-chief-of-staff persona — without restating what you already know.
5. **Generates a daily Morning Brief** — three bullets each on _what changed_, _what's at risk_, and _what needs a decision_ — before you open Slack.

Everything the AI needs is derived from the same state graph:

- **Member profiles** (skills, focus, bio) let Lattice suggest the right owner when work lands.
- **Delivery stats** (shipped count, on-time rate, average time-to-complete) are computed on read from existing `change_event` rows — no separate analytics pipeline.
- **"Can't do" flow**: any owner can respond to an assigned commitment with _busy until [date]_, _plan changed_, or _can't do at all_ + reason. The system respects the deferral so nudges stop pinging.

The entire primitive vocabulary is seven words: **intent**, **commitment**, **blocker**, **request**, **reminder**, **shift**, **signal.** Not a ticket in sight.

## How I built it

The shape I landed on is deliberately small and opinionated.

### The stack

- **Next.js 16 (App Router)** with **React 19** and TypeScript. One page (`app/page.tsx`) holds the entire client app. All business logic lives under `/app/api/v2/...` as Route Handlers.
- **Supabase** for Postgres, Row-Level Security, realtime, and auth. No custom backend service.
- **OpenAI Chat Completions** (`gpt-5.4-mini`) for all language work — interpretation, answering, brief refinement. JSON-response-format where the shape has to be exact.
- **OpenAI audio** (`gpt-4o-mini-transcribe` / `whisper-1`) for voice-to-text from the inline microphone.

### The data model

Everything collapses into a small number of tables, most of which are just "typed memory":

- `field_objects` — one table for all seven primitives, discriminated by a Postgres enum.
- `change_events` — every meaningful transition (goal_shift, blocker_emerged, commitment_completed, owner_change, deadline_move, and more).
- `goals`, `assumptions`, `confidence_signals`, `interventions` — the second-layer graph that captures _intent, risk, and belief_ alongside the concrete work.
- `team_members` — row-level-security scoped; carries skills/focus/bio/role.

Migrations are versioned and additive. The latest adds `due_at`, `deferred_until`, and `decline_reason` to field_objects so commitments can carry deadlines and structured pushback reasons.

### The AI pipeline

Two prompts — one voice. Both live in `lib/persona.ts` as shared constants so nothing can drift.

1. **`LATTICE_PERSONA`** — the voice. Dry, observant, point-of-view, 2–4 sentences, hard-bans on "as an AI", "Great question", hedging, emojis. Uses contractions. Pushes back. Willing to say what's missing.
2. **`APP_KNOWLEDGE`** — the ontology reference. Canonical one-line definitions of each primitive, one example each, plus a short map of how every tab and feature works. When you ask _"what's a signal vs a shift?"_ or _"how does this app work?"_, Lattice answers from this reference in the same voice.

The interpret pipeline builds a context block from the **team's active goal, member profiles with delivery stats, the last ten commitments, open assumptions, and recent change events** — then asks the model to emit strict JSON with entities, changes, optional goal shifts, assumption updates, and intervention suggestions.

### The unified chat

Early on I had two surfaces: a sheet for voice/text updates, and an "Ask Lattice" chat panel. They were redundant and confusing. Collapsed them into one: **a single chat input that classifies intent client-side** (question → `/api/v2/ask`, statement → `/api/v2/interpret`) and routes accordingly. The floating voice orb now just scrolls to the chat and starts recording. One surface, one conversation.

### Derive-on-read

The Morning Brief and the Nudges are both pure functions over current state — no cron, no stored nudge table. It keeps the surface area small and makes them trivially correct. The tradeoff: no push delivery (yet) to Slack or email. That's the next move.

## Challenges I ran into

A few bruises worth naming:

- **The spatial-canvas vs. list-view tension.** The first iteration was a "Team Field" — a spatial map of objects. Beautiful demo, genuinely hostile daily surface. Three separate personas I simulated (a senior PM, a founder-who-is-also-PM, and a Head of Product) independently told me the same thing: canvases die at ~50 objects; people want a list. I cut the canvas down to a secondary lens and made the list primary. That required rewriting Pulse.
- **The hardcoded 0.72.** Every commitment was stamped with a fake `0.72` confidence value on create, which made _every row look identical_ and users (correctly) read the number as "% done." Fixed by honoring AI-supplied confidence and labeling the column "conf" everywhere.
- **Owner inference.** The AI kept defaulting owners to "you" when the reporter said "me" / "self" / "I'll". Every task in the UI said "you" and nobody could re-route them. Two fixes: an explicit rule in the system prompt (_"I/me/self is not a specific assignment — leave empty"_) and an inline reassign dropdown with real team members + emails.
- **FormData vs. JSON.** The voice pipeline was silently failing because `authedFetch` was forcing `Content-Type: application/json` on every request, including multipart audio uploads. The browser's boundary was getting stomped, OpenAI was rejecting the blob, and the transcribe route was throwing into an empty 500 that made the client choke on `res.json()`. One line fix; half a day to find.
- **RLS self-update.** Members couldn't edit their own names — the team_members UPDATE policy was admin-only. Adding a self-update policy wasn't enough because a member could then POST to the admin role-change endpoint and promote themselves. Ended up writing a trigger that rejects any UPDATE that changes `role` / `user_id` / `team_space_id` unless the caller is an admin, with error code `42501`. Policy for simple cases, trigger for the invariant.
- **Persona drift.** Three system prompts evolved independently (ask, interpret, brief) and started saying different things. Pulled them all to share `LATTICE_PERSONA` — now the voice is the same everywhere, including the fallback strings when OpenAI isn't available.

## What I learned

- **Derive on read before you store.** Nudges, the Morning Brief, member delivery stats — all of them are pure functions over existing state. No sync drift, no cron, no extra table, no background job. If the state is the source of truth, computing views of it on demand is almost always simpler than maintaining a second representation.
- **The ontology is load-bearing.** "Commitment, blocker, request, shift, signal" is a genuinely better vocabulary for how a small team actually operates than "ticket". Getting the primitives right was more important than getting the UI right.
- **One voice beats many.** The persona experiment — a single dry, observant chief-of-staff tone applied across three different AI pipelines — was the thing that made Lattice feel like a product rather than a grab-bag of prompts.
- **Role-playing critics is a real design tool.** I had Sonnet act as a PM, a founder, and a Head of Product in turn and interrogate the current surface. They landed on the same three critiques independently. That convergence is a very strong signal and is basically impossible to get from real users inside one afternoon.
- **Ship the fake before the real.** Demo-seed data (fictional teammates, fictional commitments) made every prompt easier to iterate on. The cost is that those fictional owners leak into the AI's answers if you forget to clean them up — which is why the seed script now names "Demo: Diego" instead of just "Diego."

## Built with

**Languages**
- TypeScript
- SQL (PostgreSQL)

**Frameworks**
- Next.js 16 (App Router, Route Handlers, Server Components)
- React 19

**Cloud services**
- Supabase — Postgres, Row-Level Security, Realtime subscriptions, Auth
- OpenAI — Chat Completions (`gpt-5.4-mini`), audio transcription (`gpt-4o-mini-transcribe` / `whisper-1`)
- Vercel (deploy target)

**APIs and libraries**
- Supabase JS SDK (`@supabase/supabase-js`)
- OpenAI Node SDK (`openai`)
- Web APIs: `MediaRecorder`, `getUserMedia`, `FormData`, `fetch`

**Database**
- PostgreSQL 15 (via Supabase), with 8 versioned migrations, Row-Level Security policies, Postgres triggers (for invariant enforcement on `team_members`), and the Realtime publication.

**Tooling**
- ESLint, `tsc --noEmit`
- Git / GitHub

**Design decisions worth calling out as "built with"**
- **Persona-first AI design** — one shared system-prompt constant (`LATTICE_PERSONA`) applied across interpret, ask, and brief pipelines.
- **Derive-on-read analytics** — nudges and delivery stats are computed on demand from the change-event log, not stored separately.
- **Single conversation surface** — voice, text, ask-questions, and log-updates are one chat; intent is classified client-side.
