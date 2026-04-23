-- Platform-wide feedback. Any signed-in user can submit; only the platform
-- admin (maantech123@gmail.com) can read everyone's feedback. Authors can
-- read their own submissions.

create table if not exists public.platform_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists platform_feedback_created_idx
  on public.platform_feedback(created_at desc);

alter table public.platform_feedback enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select lower(email) = 'maantech123@gmail.com' from auth.users where id = auth.uid()),
    false
  );
$$;

do $$ begin
  create policy platform_feedback_self_insert on public.platform_feedback for insert
    to authenticated
    with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy platform_feedback_self_read on public.platform_feedback for select
    to authenticated
    using (user_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy platform_feedback_admin_read on public.platform_feedback for select
    to authenticated
    using (public.is_platform_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy platform_feedback_admin_delete on public.platform_feedback for delete
    to authenticated
    using (public.is_platform_admin());
exception when duplicate_object then null; end $$;
