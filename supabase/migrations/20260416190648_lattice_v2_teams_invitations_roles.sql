-- Lattice V2: team roles + invitations.
-- Adds role to team_members, created_by to team_spaces, team_invitations table,
-- the is_lattice_team_admin() helper, and RLS policies for bootstrapping teams.

-- Roles
do $$ begin
  create type lattice_team_role as enum ('owner','admin','member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lattice_invite_state as enum ('pending','accepted','revoked','expired');
exception when duplicate_object then null; end $$;

-- Add role + created_by to existing tables
alter table public.team_members
  add column if not exists role lattice_team_role not null default 'member';

alter table public.team_spaces
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Invitations
create table if not exists public.team_invitations (
  id text primary key,
  team_space_id text not null references public.team_spaces(id) on delete cascade,
  email text not null,
  token text not null unique,
  role lattice_team_role not null default 'member',
  state lattice_invite_state not null default 'pending',
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_invitations_team_idx on public.team_invitations(team_space_id);
create index if not exists team_invitations_email_idx on public.team_invitations(lower(email));
do $$ begin
  create trigger team_invitations_set_updated_at before update on public.team_invitations
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

alter table public.team_invitations enable row level security;

-- Remove the auto-join-demo trigger so new signups don't land in demo-team-space
drop trigger if exists on_auth_user_created_add_orgmind_member on auth.users;
-- (function handle_new_orgmind_user is kept but no longer fires automatically)

-- Helper: admin check
create or replace function public.is_lattice_team_admin(target_team_space_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where team_space_id = target_team_space_id
      and user_id = auth.uid()
      and role in ('owner','admin')
  );
$$;

-- RLS for invitations: members read, admins manage
do $$ begin
  create policy invite_member_read on public.team_invitations for select
    using (public.is_orgmind_team_member(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy invite_admin_insert on public.team_invitations for insert
    with check (public.is_lattice_team_admin(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy invite_admin_update on public.team_invitations for update
    using (public.is_lattice_team_admin(team_space_id));
exception when duplicate_object then null; end $$;

-- Allow admins to update and delete team_members rows
do $$ begin
  create policy team_members_admin_update on public.team_members for update
    using (public.is_lattice_team_admin(team_space_id));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy team_members_admin_delete on public.team_members for delete
    using (public.is_lattice_team_admin(team_space_id));
exception when duplicate_object then null; end $$;

-- Allow authenticated users to create team_spaces (bootstrap their own team)
do $$ begin
  create policy team_spaces_authenticated_insert on public.team_spaces for insert
    to authenticated
    with check (auth.uid() is not null);
exception when duplicate_object then null; end $$;

-- Allow user to insert themselves into a team they created (for initial owner row)
do $$ begin
  create policy team_members_self_insert on public.team_members for insert
    to authenticated
    with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Backfill: demo-team-space seed members — make first one the owner
update public.team_members
set role = 'owner'
where team_space_id = 'demo-team-space'
  and id = (select id from public.team_members where team_space_id = 'demo-team-space' order by id limit 1)
  and role = 'member';
