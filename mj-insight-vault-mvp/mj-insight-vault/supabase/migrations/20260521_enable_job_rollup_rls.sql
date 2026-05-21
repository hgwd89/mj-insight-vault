alter table if exists public.chat_jobs enable row level security;
alter table if exists public.monthly_rollups enable row level security;

revoke all on table public.chat_jobs from anon, authenticated;
revoke all on table public.monthly_rollups from anon, authenticated;
