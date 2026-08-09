drop policy if exists deny_anon_authenticated_chat_jobs on public.chat_jobs;
create policy deny_anon_authenticated_chat_jobs
on public.chat_jobs
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists deny_anon_authenticated_monthly_rollups on public.monthly_rollups;
create policy deny_anon_authenticated_monthly_rollups
on public.monthly_rollups
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

alter function public.set_chat_jobs_updated_at() set search_path = public, pg_temp;