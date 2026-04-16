create extension if not exists pgcrypto;

do $$
begin
  create type public.lattice_object_type as enum (
    'intent',
    'promise',
    'blocker',
    'shift',
    'request',
    'reminder',
    'signal'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.lattice_request_state as enum (
    'draft',
    'sent',
    'acknowledged',
    'resolved',
    'denied'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.team_spaces (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  active_intent text not null default 'Ship a demo people trust',
  tensions text[] not null default '{}',
  broadcast text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_members (
  id text primary key default gen_random_uuid()::text,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  role text,
  created_at timestamptz not null default now()
);

alter table public.team_members
add column if not exists user_id uuid references auth.users(id) on delete cascade;

create unique index if not exists team_members_team_space_user_idx
on public.team_members(team_space_id, user_id)
where user_id is not null;

create table if not exists public.field_objects (
  id text primary key default gen_random_uuid()::text,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  type public.lattice_object_type not null,
  title text not null,
  detail text not null,
  owner text,
  status text,
  confidence numeric not null default 0.7 check (confidence >= 0 and confidence <= 1),
  position_x numeric not null default 50 check (position_x >= 0 and position_x <= 100),
  position_y numeric not null default 50 check (position_y >= 0 and position_y <= 100),
  pulse text not null default 'quiet' check (pulse in ('quiet', 'active', 'tense', 'stale', 'clear')),
  links text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memory_events (
  id text primary key default gen_random_uuid()::text,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  kind public.lattice_object_type,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.delegated_requests (
  id text primary key default gen_random_uuid()::text,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  target text not null,
  ask text not null,
  why text not null,
  state public.lattice_request_state not null default 'draft',
  linked_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reminders (
  id text primary key default gen_random_uuid()::text,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  text text not null,
  trigger text not null,
  linked_to text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.interpretations (
  id text primary key default gen_random_uuid()::text,
  team_space_id text references public.team_spaces(id) on delete cascade,
  raw_input text not null,
  reply text not null,
  entities jsonb not null default '[]'::jsonb,
  follow_up_question text,
  broadcast jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_team_spaces_updated_at on public.team_spaces;
create trigger set_team_spaces_updated_at
before update on public.team_spaces
for each row execute function public.set_updated_at();

drop trigger if exists set_field_objects_updated_at on public.field_objects;
create trigger set_field_objects_updated_at
before update on public.field_objects
for each row execute function public.set_updated_at();

drop trigger if exists set_delegated_requests_updated_at on public.delegated_requests;
create trigger set_delegated_requests_updated_at
before update on public.delegated_requests
for each row execute function public.set_updated_at();

drop trigger if exists set_reminders_updated_at on public.reminders;
create trigger set_reminders_updated_at
before update on public.reminders
for each row execute function public.set_updated_at();

create index if not exists field_objects_team_space_idx on public.field_objects(team_space_id);
create index if not exists memory_events_team_space_created_idx on public.memory_events(team_space_id, created_at desc);
create index if not exists delegated_requests_team_space_idx on public.delegated_requests(team_space_id);
create index if not exists reminders_team_space_idx on public.reminders(team_space_id);
create index if not exists interpretations_team_space_created_idx on public.interpretations(team_space_id, created_at desc);

create or replace function public.is_lattice_team_member(target_team_space_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members
    where team_space_id = target_team_space_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.handle_new_lattice_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.team_members (team_space_id, user_id, name, role)
  values (
    'demo-team-space',
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', new.email, 'New teammate'),
    'Teammate'
  )
  on conflict (team_space_id, user_id) where user_id is not null do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_add_lattice_member on auth.users;
create trigger on_auth_user_created_add_lattice_member
after insert on auth.users
for each row execute function public.handle_new_lattice_user();

alter table public.team_spaces enable row level security;
alter table public.team_members enable row level security;
alter table public.field_objects enable row level security;
alter table public.memory_events enable row level security;
alter table public.delegated_requests enable row level security;
alter table public.reminders enable row level security;
alter table public.interpretations enable row level security;

drop policy if exists "Demo users can read team spaces" on public.team_spaces;
create policy "Demo users can read team spaces"
on public.team_spaces for select
to authenticated
using (public.is_lattice_team_member(id));

drop policy if exists "Demo users can update team spaces" on public.team_spaces;
create policy "Demo users can update team spaces"
on public.team_spaces for update
to authenticated
using (public.is_lattice_team_member(id))
with check (public.is_lattice_team_member(id));

drop policy if exists "Demo users can read team members" on public.team_members;
create policy "Demo users can read team members"
on public.team_members for select
to authenticated
using (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can read field state" on public.field_objects;
create policy "Demo users can read field state"
on public.field_objects for select
to authenticated
using (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can create field state" on public.field_objects;
create policy "Demo users can create field state"
on public.field_objects for insert
to authenticated
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can update field state" on public.field_objects;
create policy "Demo users can update field state"
on public.field_objects for update
to authenticated
using (public.is_lattice_team_member(team_space_id))
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can read memory" on public.memory_events;
create policy "Demo users can read memory"
on public.memory_events for select
to authenticated
using (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can create memory" on public.memory_events;
create policy "Demo users can create memory"
on public.memory_events for insert
to authenticated
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can read delegated requests" on public.delegated_requests;
create policy "Demo users can read delegated requests"
on public.delegated_requests for select
to authenticated
using (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can create delegated requests" on public.delegated_requests;
create policy "Demo users can create delegated requests"
on public.delegated_requests for insert
to authenticated
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can update delegated requests" on public.delegated_requests;
create policy "Demo users can update delegated requests"
on public.delegated_requests for update
to authenticated
using (public.is_lattice_team_member(team_space_id))
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can read reminders" on public.reminders;
create policy "Demo users can read reminders"
on public.reminders for select
to authenticated
using (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can create reminders" on public.reminders;
create policy "Demo users can create reminders"
on public.reminders for insert
to authenticated
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can update reminders" on public.reminders;
create policy "Demo users can update reminders"
on public.reminders for update
to authenticated
using (public.is_lattice_team_member(team_space_id))
with check (public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can read interpretations" on public.interpretations;
create policy "Demo users can read interpretations"
on public.interpretations for select
to authenticated
using (team_space_id is null or public.is_lattice_team_member(team_space_id));

drop policy if exists "Demo users can create interpretations" on public.interpretations;
create policy "Demo users can create interpretations"
on public.interpretations for insert
to authenticated
with check (team_space_id is null or public.is_lattice_team_member(team_space_id));

insert into public.team_spaces (id, name, active_intent, tensions, broadcast)
values (
  'demo-team-space',
  'Hackathon Demo Team',
  'Ship a demo people trust',
  array[
    'Auth edge cases still affect deployment confidence.',
    'Analytics scope is waiting on lead approval.',
    'Onboarding promise has no latest update after the scope shift.'
  ],
  array[
    'Demo reliability is now the active team intent.',
    'Backend auth remains the main deployment blocker.',
    'Analytics may be deprioritized pending approval.'
  ]
)
on conflict (id) do nothing;

insert into public.team_members (id, team_space_id, name, role)
values
  ('member-aryan', 'demo-team-space', 'Aryan', 'Frontend'),
  ('member-meera', 'demo-team-space', 'Meera', 'Backend'),
  ('member-team-lead', 'demo-team-space', 'Team lead', 'Coordination')
on conflict (id) do nothing;

insert into public.field_objects (
  id,
  team_space_id,
  type,
  title,
  detail,
  owner,
  status,
  confidence,
  position_x,
  position_y,
  pulse,
  links
)
values
  (
    'intent-demo',
    'demo-team-space',
    'intent',
    'Demo reliability',
    'The team is optimizing for a stable judge walkthrough.',
    'Team',
    'primary intent',
    0.82,
    50,
    46,
    'active',
    array['promise-onboarding', 'blocker-backend', 'request-analytics']
  ),
  (
    'promise-onboarding',
    'demo-team-space',
    'promise',
    'Onboarding flow',
    'Aryan will finish the core flow before tonight''s dry run.',
    'Aryan',
    'in motion',
    0.68,
    33,
    31,
    'clear',
    array['intent-demo']
  ),
  (
    'blocker-backend',
    'demo-team-space',
    'blocker',
    'Auth edge cases',
    'Backend auth is unstable around new user sessions.',
    'Meera',
    'blocking deployment',
    0.44,
    69,
    34,
    'tense',
    array['intent-demo', 'reminder-auth']
  ),
  (
    'request-analytics',
    'demo-team-space',
    'request',
    'Analytics deprioritization',
    'Ask lead to pause analytics and protect demo flow.',
    'Lattice',
    'draft',
    0.59,
    62,
    66,
    'active',
    array['intent-demo']
  ),
  (
    'reminder-auth',
    'demo-team-space',
    'reminder',
    'Retry auth test',
    'Bring back the auth test after backend patch lands.',
    'Me',
    '8:00 PM',
    0.77,
    39,
    70,
    'quiet',
    array['blocker-backend']
  )
on conflict (id) do nothing;

insert into public.memory_events (id, team_space_id, kind, text, created_at)
values
  ('mem-1', 'demo-team-space', 'shift', 'Goal shifted from feature breadth to demo reliability.', now() - interval '58 minutes'),
  ('mem-2', 'demo-team-space', 'blocker', 'Auth edge cases linked to deployment risk.', now() - interval '13 minutes'),
  ('mem-3', 'demo-team-space', 'request', 'Analytics pause request drafted for lead approval.', now() - interval '1 minute')
on conflict (id) do nothing;

insert into public.delegated_requests (id, team_space_id, target, ask, why, state, linked_to)
values (
  'req-1',
  'demo-team-space',
  'Team lead',
  'Can analytics pause while the demo flow gets stabilized?',
  'Demo reliability is the current team intent.',
  'draft',
  'Demo reliability'
)
on conflict (id) do nothing;

insert into public.reminders (id, team_space_id, text, trigger, linked_to)
values (
  'rem-1',
  'demo-team-space',
  'Retry auth test after backend patch',
  '8:00 PM',
  'Auth edge cases'
)
on conflict (id) do nothing;
