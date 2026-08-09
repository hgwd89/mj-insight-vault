begin;

create table if not exists public.legacy_derived_freeze_receipts_v1 (
  id uuid primary key default gen_random_uuid(),
  frozen_at timestamptz not null default now(),
  legacy_article_profiles_count integer not null,
  legacy_category_memberships_count integer not null,
  legacy_embeddings_count integer not null,
  legacy_scan_run_count integer not null,
  legacy_report_count integer not null,
  note text not null default 'Raw/provenance retained; legacy derived outputs are read-only and excluded from strict formal proof.'
);

alter table public.legacy_derived_freeze_receipts_v1 enable row level security;
revoke all on public.legacy_derived_freeze_receipts_v1 from anon, authenticated;
grant select on public.legacy_derived_freeze_receipts_v1 to service_role;

insert into public.legacy_derived_freeze_receipts_v1(
  legacy_article_profiles_count,
  legacy_category_memberships_count,
  legacy_embeddings_count,
  legacy_scan_run_count,
  legacy_report_count
)
select
  (select count(*)::int from public.article_profiles),
  (select count(*)::int from public.article_category_memberships),
  (select count(*)::int from public.article_embeddings),
  (select count(*)::int from public.full_corpus_scan_runs where coalesce(analysis_contract_version,'') <> 'strict_report_v4_source_census'),
  (select count(*)::int from public.chat_reports where coalesce((answer_json->>'formal_gate_version'),'') <> 'formal_report_v6_claim_graph');

-- Legacy derived tables are retained for audit/readback but cannot receive new server-side writes.
revoke insert, update, delete, truncate on public.article_profiles from service_role;
revoke insert, update, delete, truncate on public.article_category_memberships from service_role;
revoke insert, update, delete, truncate on public.article_embeddings from service_role;
grant select on public.article_profiles to service_role;
grant select on public.article_category_memberships to service_role;
grant select on public.article_embeddings to service_role;

-- Freeze explicitly legacy worker entry points.
revoke execute on function public.claim_article_classification_jobs_v2(integer,integer) from service_role;
revoke execute on function public.complete_article_classification_job_v2(uuid,uuid,jsonb,jsonb) from service_role;
revoke execute on function public.enqueue_article_classification_v2(boolean,text) from service_role;
revoke execute on function public.fail_article_classification_job_v2(uuid,uuid,text,boolean) from service_role;
revoke execute on function public.kick_active_v2_corpus_scan_v1() from service_role;

create or replace view public.legacy_derived_inventory_v1
with (security_invoker=true)
as
select 'article_profiles'::text asset_type, count(*)::bigint row_count, 'legacy_read_only'::text status from public.article_profiles
union all
select 'article_category_memberships', count(*)::bigint, 'legacy_read_only' from public.article_category_memberships
union all
select 'article_embeddings', count(*)::bigint, 'legacy_read_only' from public.article_embeddings
union all
select 'full_corpus_scan_runs_legacy', count(*)::bigint, 'legacy_read_only'
from public.full_corpus_scan_runs where coalesce(analysis_contract_version,'') <> 'strict_report_v4_source_census'
union all
select 'chat_reports_legacy', count(*)::bigint, 'legacy_read_only'
from public.chat_reports where coalesce((answer_json->>'formal_gate_version'),'') <> 'formal_report_v6_claim_graph';

revoke all on public.legacy_derived_inventory_v1 from anon, authenticated;
grant select on public.legacy_derived_inventory_v1 to service_role;

commit;