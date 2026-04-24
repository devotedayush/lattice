-- Shareable team join links plus admin-reviewed join requests.

do $$ begin
  create type lattice_join_request_state as enum ('pending','approved','rejected','cancelled');
exception when duplicate_object then null; end $$;

alter table public.team_spaces
  add column if not exists join_token text;

update public.team_spaces
set join_token = replace(gen_random_uuid()::text, '-', '')
where join_token is null;

alter table public.team_spaces
  alter column join_token set default replace(gen_random_uuid()::text, '-', '');

alter table public.team_spaces
  alter column join_token set not null;

create unique index if not exists team_spaces_join_token_idx
on public.team_spaces(join_token);

create table if not exists public.team_join_requests (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  email text,
  message text,
  state lattice_join_request_state not null default 'pending',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(team_space_id, user_id)
);

create index if not exists team_join_requests_team_state_idx
on public.team_join_requests(team_space_id, state, created_at desc);

create index if not exists team_join_requests_user_idx
on public.team_join_requests(user_id, state);

do $$ begin
  create trigger team_join_requests_set_updated_at before update on public.team_join_requests
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

alter table public.team_join_requests enable row level security;

do $$ begin
  create policy team_join_requests_read on public.team_join_requests for select
    to authenticated
    using (
      (select auth.uid()) = user_id
      or public.is_lattice_team_admin(team_space_id)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy team_join_requests_insert on public.team_join_requests for insert
    to authenticated
    with check (
      (select auth.uid()) = user_id
      and state = 'pending'
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy team_join_requests_admin_update on public.team_join_requests for update
    to authenticated
    using (public.is_lattice_team_admin(team_space_id))
    with check (public.is_lattice_team_admin(team_space_id));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy team_members_admin_insert on public.team_members for insert
    to authenticated
    with check (public.is_lattice_team_admin(team_space_id));
exception when duplicate_object then null; end $$;
