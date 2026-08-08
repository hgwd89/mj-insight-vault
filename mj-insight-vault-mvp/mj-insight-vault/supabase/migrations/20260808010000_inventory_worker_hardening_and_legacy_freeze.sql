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
  (select count(*)::int from public.chat_reports where coalesce((answer_json->>'formal_gate_version'),'') <> 'formal_report_v6_claim_graph')
where not exists (
  select 1 from public.legacy_derived_freeze_receipts_v1
  where note='Raw/provenance retained; legacy derived outputs are read-only and excluded from strict formal proof.'
);

revoke insert, update, delete, truncate on public.article_profiles from service_role;
revoke insert, update, delete, truncate on public.article_category_memberships from service_role;
revoke insert, update, delete, truncate on public.article_embeddings from service_role;
grant select on public.article_profiles to service_role;
grant select on public.article_category_memberships to service_role;
grant select on public.article_embeddings to service_role;

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

create or replace function public.renew_source_page_article_inventory_job_lease_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 420
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_v1_lease_invalid';
  end if;
  update public.source_page_article_inventory_jobs_v1
     set lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))), updated_at=now()
   where id=p_job_id;
  return jsonb_build_object('status','running','lease_expires_at',(select lease_expires_at from public.source_page_article_inventory_jobs_v1 where id=p_job_id));
end
$function$;

create or replace function public.fail_source_page_article_inventory_job_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_message text,
  p_retryable boolean default true
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype; v_next text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'inventory_v1_fail_lease_invalid'; end if;
  v_next:=case when coalesce(p_retryable,true) and j.attempt_count<4 then 'queued' else 'failed' end;
  update public.source_page_article_inventory_jobs_v1
     set status=v_next, lease_token=null, lease_expires_at=null,
         error_message=left(coalesce(p_error_message,'inventory worker failed'),4000), updated_at=now(),
         finished_at=case when v_next='failed' then now() else null end
   where id=p_job_id;
  return jsonb_build_object('status',v_next,'attempt_count',j.attempt_count,'retry_scheduled',(v_next='queued'));
end
$function$;

create or replace function public.review_source_page_article_inventory_job_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'inventory_v1_review_lease_invalid'; end if;
  update public.source_page_article_inventory_jobs_v1
     set status='needs_review', lease_token=null, lease_expires_at=null,
         error_message=left(coalesce(p_reason,'manual review required'),4000), updated_at=now()
   where id=p_job_id;
  return jsonb_build_object('status','needs_review','reason',left(coalesce(p_reason,'manual review required'),4000));
end
$function$;

create or replace function public.requeue_source_page_article_inventory_job_v1(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then raise exception 'inventory_v1_freeze_stale'; end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status not in ('failed','needs_review') then raise exception 'inventory_v1_requeue_not_allowed'; end if;
  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=p_job_id;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=p_job_id;
  delete from public.source_page_article_inventory_mappings_v2 where job_id=p_job_id;
  delete from public.source_page_article_inventory_groups_v1 where job_id=p_job_id;
  delete from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id;
  update public.source_page_article_inventory_jobs_v1
     set status='queued', lease_token=null, lease_expires_at=null, error_message=null,
         finished_at=null, attempt_count=0, updated_at=now()
   where id=p_job_id;
  return jsonb_build_object('status','queued','proofs_reset',true);
end
$function$;

revoke all on function public.renew_source_page_article_inventory_job_lease_v1(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.fail_source_page_article_inventory_job_v1(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.review_source_page_article_inventory_job_v1(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.requeue_source_page_article_inventory_job_v1(uuid) from public,anon,authenticated;
grant execute on function public.renew_source_page_article_inventory_job_lease_v1(uuid,uuid,integer) to service_role;
grant execute on function public.fail_source_page_article_inventory_job_v1(uuid,uuid,text,boolean) to service_role;
grant execute on function public.review_source_page_article_inventory_job_v1(uuid,uuid,text) to service_role;
grant execute on function public.requeue_source_page_article_inventory_job_v1(uuid) to service_role;

commit;
