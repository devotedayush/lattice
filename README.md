# Lattice V1

Lattice V1 is a prototype for a living team state interface. The first screen is the Team Field: a spatial map of intent, promises, blockers, requests, reminders, shifts, signals, tensions, and memory.

## Stack

- Next.js 16
- React 19
- Supabase schema in `supabase/schema.sql`
- Supabase-backed Team Field persistence via `/api/team-state`
- Supabase email/password auth with demo team membership policies
- OpenAI Chat Completions for state interpretation
- OpenAI audio transcription route for voice updates, defaulting to `gpt-4o-mini-transcribe`

## Run

```bash
npm install
npm run dev
```

Create `.env.local` from `.env.example` when you want live AI and Supabase wiring:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
LATTICE_TEAM_SPACE_ID=demo-team-space
APP_BASE_URL=https://lattice-opal.vercel.app
```

Without `OPENAI_API_KEY`, text interpretation uses a local fallback parser so the prototype still works.
Without `SUPABASE_SERVICE_ROLE_KEY`, the demo uses the public anon key and the RLS policies in `supabase/schema.sql`.
Set `APP_BASE_URL` to `http://localhost:3000` for local development; production emails should use `https://lattice-opal.vercel.app`.

## V1 Surface

- Team Field home interface
- Voice Orb + transcription endpoint
- Text signal composer
- Visible AI interpretation before applying changes
- Promise, blocker, reminder, request, shift, signal creation
- Request Console with request states
- Personal Memory Lens
- Team reality broadcast and active tensions
- Supabase persistence for field objects, memory events, reminders, delegated requests, broadcasts, tensions, and interpretation logs
- Basic sign in/sign up flow before the Team Field loads
