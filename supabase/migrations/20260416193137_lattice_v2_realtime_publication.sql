-- Enable Supabase Realtime for tables that drive the live Lattice UI.
-- Without this, the app's subscription silently no-ops.
alter publication supabase_realtime add table public.change_events;
alter publication supabase_realtime add table public.interventions;
alter publication supabase_realtime add table public.goals;
alter publication supabase_realtime add table public.field_objects;
alter publication supabase_realtime add table public.assumptions;
alter publication supabase_realtime add table public.team_members;
alter publication supabase_realtime add table public.team_invitations;
