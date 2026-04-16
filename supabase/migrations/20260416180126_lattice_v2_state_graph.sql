-- Lattice V2: Organizational State Graph.
-- Adds first-class goals, change_events, assumptions, dependencies,
-- confidence_signals, and interventions on top of the V1 team_spaces +
-- field_objects surface.

do $$ begin
  create type lattice_change_kind as enum (
    'goal_shift','scope_change','priority_change','deadline_move','owner_change',
    'blocker_emerged','blocker_resolved','assumption_invalidated','confidence_change',
    'commitment_added','commitment_completed','commitment_stale'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type lattice_intervention_state as enum ('suggested','accepted','dismissed','acted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lattice_goal_state as enum ('active','paused','achieved','dropped','superseded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lattice_assumption_state as enum ('holds','at_risk','invalidated','reconfirmed');
exception when duplicate_object then null; end $$;

create table if not exists public.goals (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  title text not null,
  detail text,
  state lattice_goal_state not null default 'active',
  priority int not null default 1,
  confidence numeric not null default 0.7 check (confidence >= 0 and confidence <= 1),
  previous_goal_id text references public.goals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists goals_team_idx on public.goals(team_space_id);

do $$ begin
  create trigger goals_set_updated_at before update on public.goals
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

create table if not exists public.change_events (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  kind lattice_change_kind not null,
  summary text not null,
  detail text,
  target_id text,
  target_type text,
  previous_value jsonb,
  new_value jsonb,
  source text,
  reported_by uuid references auth.users(id) on delete set null,
  impact jsonb,
  created_at timestamptz not null default now()
);
create index if not exists change_events_team_idx on public.change_events(team_space_id, created_at desc);
create index if not exists change_events_kind_idx on public.change_events(team_space_id, kind);

create table if not exists public.assumptions (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  statement text not null,
  state lattice_assumption_state not null default 'holds',
  tied_to text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assumptions_team_idx on public.assumptions(team_space_id);

do $$ begin
  create trigger assumptions_set_updated_at before update on public.assumptions
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

create table if not exists public.dependencies (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  source_id text not null,
  target_kind text not null,
  target_ref text not null,
  note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists dependencies_team_idx on public.dependencies(team_space_id);

create table if not exists public.confidence_signals (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  target_id text not null,
  target_type text not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  note text,
  reported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists confidence_signals_target_idx on public.confidence_signals(team_space_id, target_id, created_at desc);

create table if not exists public.interventions (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  title text not null,
  rationale text not null,
  action_kind text not null,
  urgency int not null default 2 check (urgency between 1 and 5),
  target_id text,
  target_type text,
  state lattice_intervention_state not null default 'suggested',
  dismissed_at timestamptz,
  acted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists interventions_team_idx on public.interventions(team_space_id, state, created_at desc);

do $$ begin
  create trigger interventions_set_updated_at before update on public.interventions
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

alter table public.goals enable row level security;
alter table public.change_events enable row level security;
alter table public.assumptions enable row level security;
alter table public.dependencies enable row level security;
alter table public.confidence_signals enable row level security;
alter table public.interventions enable row level security;

do $$ begin
  create policy goals_member_read on public.goals for select using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy goals_member_write on public.goals for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy goals_member_update on public.goals for update using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy change_events_member_read on public.change_events for select using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy change_events_member_write on public.change_events for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy assumptions_member_read on public.assumptions for select using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy assumptions_member_write on public.assumptions for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy assumptions_member_update on public.assumptions for update using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy dependencies_member_read on public.dependencies for select using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy dependencies_member_write on public.dependencies for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy dependencies_member_update on public.dependencies for update using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy confidence_signals_member_read on public.confidence_signals for select using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy confidence_signals_member_write on public.confidence_signals for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy interventions_member_read on public.interventions for select using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy interventions_member_write on public.interventions for insert with check (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy interventions_member_update on public.interventions for update using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
