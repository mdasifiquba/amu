-- Run this once in Supabase Dashboard > SQL Editor.
-- Browser clients use only the publishable/anon key; RLS protects student results.

create table if not exists public.submissions (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.submissions enable row level security;

revoke all on public.submissions from anon, authenticated;
grant insert on public.submissions to anon, authenticated;
grant select, delete on public.submissions to authenticated;

drop policy if exists "Anyone can submit a result" on public.submissions;
create policy "Anyone can submit a result"
  on public.submissions for insert to anon, authenticated
  with check (jsonb_typeof(record) = 'object');

drop policy if exists "Admins can read results" on public.submissions;
create policy "Admins can read results"
  on public.submissions for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "Admins can delete results" on public.submissions;
create policy "Admins can delete results"
  on public.submissions for delete to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- After creating the admin user in Authentication > Users, mark that user as admin.
-- Replace the email below and run this separately in the SQL Editor:
-- update auth.users
-- set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
-- where email = 'YOUR_ADMIN_EMAIL';
