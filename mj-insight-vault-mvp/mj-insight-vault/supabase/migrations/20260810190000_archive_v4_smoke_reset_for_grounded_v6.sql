-- Archive the V4 visual-inventory smoke state once, reset its formal outputs once,
-- and require Grounded V6 evidence before the formal inventory gate can pass.
-- IMPORTANT: the destructive reset is guarded by the archive marker so replaying this
-- migration against a DB that already performed the pre-V6 reset cannot erase V6 progress.

create table if not exists public.source_page_inventory_v4_attempt_archive_v6 (
  archive_id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  archived_at timestamptz not null default now(),
  archive_reason text not null,
  job_snapshot jsonb not null,
  pass_runs jsonb not null default '[]'::jsonb,
  groups_snapshot jsonb not null default '[]'::jsonb,
  mapping_pass_runs jsonb not null default '[]'::jsonb,
  mappings_snapshot jsonb not null default '[]'::jsonb,
  visual_consensus_receipt jsonb,
  visual_group_evidence jsonb not null default '[]'::jsonb,
  materialization_receipts jsonb not null default '[]'::jsonb,
  assignments_snapshot jsonb not null default '[]'::jsonb,
  unique(job_id,archive_reason)
);

alter table public.source_page_inventory_v4_attempt_archive_v6 enable row level security;
revoke all on table public.source_page_inventory_v4_attempt_archive_v6 from public,anon,authenticated;
grant select,insert on table public.source_page_inventory_v4_attempt_archive_v6 to service_role;

do $$
begin
  if not exists (
    select 1 from public.source_page_inventory_v4_attempt_archive_v6
    where archive_reason='pre_v6_grounded_inventory_reset_20260810'
  ) then
    insert into public.source_page_inventory_v4_attempt_archive_v6(
      job_id,archive_reason,job_snapshot,pass_runs,groups_snapshot,mapping_pass_runs,mappings_snapshot,
      visual_consensus_receipt,visual_group_evidence,materialization_receipts,assignments_snapshot
    )
    select j.id,
           'pre_v6_grounded_inventory_reset_20260810',
           to_jsonb(j),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.source_page_article_inventory_pass_runs_v1 x where x.job_id=j.id),'[]'::jsonb),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind,x.group_fingerprint) from public.source_page_article_inventory_groups_v1 x where x.job_id=j.id),'[]'::jsonb),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.source_page_article_inventory_mapping_pass_runs_v2 x where x.job_id=j.id),'[]'::jsonb),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.article_id) from public.source_page_article_inventory_mappings_v2 x where x.job_id=j.id),'[]'::jsonb),
           (select to_jsonb(x) from public.source_page_inventory_visual_consensus_receipts_v4 x where x.job_id=j.id),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind,x.original_group_fingerprint) from public.source_page_inventory_visual_group_evidence_v4 x where x.job_id=j.id),'[]'::jsonb),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.source_region_materialization_receipts_v6 x where x.inventory_job_id=j.id),'[]'::jsonb),
           coalesce((select jsonb_agg(to_jsonb(x) order by x.block_index) from public.source_inventory_block_assignments_v7 x where x.inventory_job_id=j.id),'[]'::jsonb)
    from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr';

    update public.inventory_v3_execution_control_v1
       set enabled=false,reason='paused: V4 smoke archived; awaiting grounded V6 deployment',updated_at=now()
     where singleton=true;

    delete from public.article_source_regions r
    where r.partition_job_id in (
      select mr.partition_job_id
      from public.source_region_materialization_receipts_v6 mr
      join public.source_page_article_inventory_jobs_v1 j on j.id=mr.inventory_job_id
      where j.inventory_version='page_article_inventory_v4_recovered_ocr'
    );

    delete from public.source_page_partition_jobs_v3 p
    where p.id in (
      select mr.partition_job_id
      from public.source_region_materialization_receipts_v6 mr
      join public.source_page_article_inventory_jobs_v1 j on j.id=mr.inventory_job_id
      where j.inventory_version='page_article_inventory_v4_recovered_ocr'
    );

    delete from public.source_inventory_block_assignments_v7 a
    using public.source_page_article_inventory_jobs_v1 j
    where a.inventory_job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_inventory_visual_region_evidence_v6 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_inventory_visual_group_evidence_v4 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_inventory_visual_consensus_receipts_v4 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_article_inventory_mappings_v2 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_article_inventory_mapping_pass_runs_v2 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_article_inventory_mapping_stage_v2 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_article_inventory_groups_v1 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    delete from public.source_page_article_inventory_pass_runs_v1 e
    using public.source_page_article_inventory_jobs_v1 j
    where e.job_id=j.id and j.inventory_version='page_article_inventory_v4_recovered_ocr';

    -- Keep requires_third_pass conservative: an extra independent adjudicator is safe.
    update public.source_page_article_inventory_jobs_v1
       set status='queued',attempt_count=0,lease_token=null,lease_expires_at=null,
           error_message=null,finished_at=null,updated_at=now()
     where inventory_version='page_article_inventory_v4_recovered_ocr';
  end if;
end $$;

create or replace view public.source_page_article_inventory_gate_v2 as
with fg as (
  select freeze_receipt_id from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed'
), expected as (
  select count(*)::integer as pages from public.source_page_inventory_capture_v1
), s as (
  select count(*)::integer as jobs,
         count(*) filter(where j.status='completed')::integer as completed,
         count(*) filter(where j.status='discovery_required')::integer as discovery_required,
         count(*) filter(where j.status='needs_review')::integer as needs_review,
         count(*) filter(where j.status='failed')::integer as failed,
         count(*) filter(where j.status='completed' and
           (select count(distinct e.pass_kind)
              from public.source_page_inventory_visual_region_evidence_v6 e
             where e.job_id=j.id and e.pass_kind in ('mapper','critic'))=2
         )::integer as grounded_v6_completed
  from public.source_page_article_inventory_jobs_v1 j
  join fg on fg.freeze_receipt_id=j.freeze_receipt_id
  where j.inventory_version='page_article_inventory_v4_recovered_ocr'
)
select expected.pages,s.jobs,s.completed,s.discovery_required,s.needs_review,s.failed,
       case
         when s.discovery_required>0 then 'discovery_required'
         when s.needs_review>0 or s.failed>0 then 'failed'
         when s.jobs<>expected.pages or s.completed<>expected.pages then 'pending'
         when s.grounded_v6_completed<>expected.pages then 'failed'
         else 'passed'
       end as inventory_gate,
       case
         when s.discovery_required>0 then 'recovered_inventory_discovery_required'
         when s.failed>0 then 'recovered_inventory_failed'
         when s.needs_review>0 then 'recovered_inventory_review_required'
         when s.jobs<>expected.pages then 'recovered_inventory_jobs_incomplete'
         when s.completed<>expected.pages then 'recovered_inventory_incomplete'
         when s.grounded_v6_completed<>expected.pages then 'grounded_v6_evidence_incomplete'
         else 'passed'
       end as gate_reason
from expected cross join s;

-- Authoritative readiness must use the recovered/Grounded-V6-aware gate, not the legacy all-version gate.
do $$
declare ddl text;
begin
  select pg_get_functiondef('public.pipeline_readiness_json_v10()'::regprocedure) into ddl;
  ddl := replace(ddl,
    'inv public.source_page_article_inventory_gate_v1%rowtype;',
    'inv public.source_page_article_inventory_gate_v2%rowtype;');
  ddl := replace(ddl,
    'select * into inv from public.source_page_article_inventory_gate_v1;',
    'select * into inv from public.source_page_article_inventory_gate_v2;');
  execute ddl;
end $$;
