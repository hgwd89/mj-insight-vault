-- Archive the rejected Grounded V6 adjudicator smoke and restore the affected jobs
-- to their Mapper/Critic-complete pre-adjudicator state. This deliberately preserves
-- the V6 raw Mapper/Critic receipts while invalidating all artifacts derived from the
-- rejected adjudicator evidence.

create table if not exists public.source_page_inventory_v6_adjudicator_smoke_archive_v7 (
  archive_id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  archived_at timestamptz not null default now(),
  archive_reason text not null,
  job_snapshot jsonb not null,
  adjudicator_pass_runs jsonb not null default '[]'::jsonb,
  adjudicator_groups jsonb not null default '[]'::jsonb,
  adjudicator_region_evidence jsonb not null default '[]'::jsonb,
  visual_consensus_receipt jsonb,
  visual_group_evidence jsonb not null default '[]'::jsonb,
  mapping_pass_runs jsonb not null default '[]'::jsonb,
  mappings_snapshot jsonb not null default '[]'::jsonb,
  unique(job_id,archive_reason)
);

alter table public.source_page_inventory_v6_adjudicator_smoke_archive_v7 enable row level security;
revoke all on table public.source_page_inventory_v6_adjudicator_smoke_archive_v7 from public,anon,authenticated;
grant select,insert on table public.source_page_inventory_v6_adjudicator_smoke_archive_v7 to service_role;

do $$
begin
  if exists (
    select 1
    from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and exists (
        select 1 from public.source_page_inventory_visual_region_evidence_v6 e
        where e.job_id=j.id and e.pass_kind='adjudicator'
      )
      and (
        j.status not in ('queued','needs_review')
        or exists (select 1 from public.source_region_materialization_receipts_v6 m where m.inventory_job_id=j.id)
      )
  ) then
    raise exception 'unsafe_v6_adjudicator_smoke_revert_target';
  end if;
end $$;

insert into public.source_page_inventory_v6_adjudicator_smoke_archive_v7(
  job_id,archive_reason,job_snapshot,adjudicator_pass_runs,adjudicator_groups,
  adjudicator_region_evidence,visual_consensus_receipt,visual_group_evidence,
  mapping_pass_runs,mappings_snapshot
)
select j.id,
       'v6_grounded_adjudicator_smoke_20260810',
       to_jsonb(j),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.source_page_article_inventory_pass_runs_v1 x where x.job_id=j.id and x.pass_kind='adjudicator'),'[]'::jsonb),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.group_fingerprint) from public.source_page_article_inventory_groups_v1 x where x.job_id=j.id and x.pass_kind='adjudicator'),'[]'::jsonb),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.article_seq) from public.source_page_inventory_visual_region_evidence_v6 x where x.job_id=j.id and x.pass_kind='adjudicator'),'[]'::jsonb),
       (select to_jsonb(x) from public.source_page_inventory_visual_consensus_receipts_v4 x where x.job_id=j.id),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind,x.original_group_fingerprint) from public.source_page_inventory_visual_group_evidence_v4 x where x.job_id=j.id),'[]'::jsonb),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.source_page_article_inventory_mapping_pass_runs_v2 x where x.job_id=j.id),'[]'::jsonb),
       coalesce((select jsonb_agg(to_jsonb(x) order by x.article_id) from public.source_page_article_inventory_mappings_v2 x where x.job_id=j.id),'[]'::jsonb)
from public.source_page_article_inventory_jobs_v1 j
where j.inventory_version='page_article_inventory_v4_recovered_ocr'
  and j.status in ('queued','needs_review')
  and exists (
    select 1 from public.source_page_inventory_visual_region_evidence_v6 e
    where e.job_id=j.id and e.pass_kind='adjudicator'
  )
on conflict(job_id,archive_reason) do nothing;

-- Invalidate every downstream artifact that may have been derived after the rejected
-- adjudicator while retaining Mapper/Critic pass and raw-region evidence.
delete from public.source_page_article_inventory_mappings_v2 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_article_inventory_mapping_pass_runs_v2 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_article_inventory_mapping_stage_v2 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_inventory_visual_group_evidence_v4 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_inventory_visual_consensus_receipts_v4 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_inventory_visual_region_evidence_v6 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and x.pass_kind='adjudicator'
  and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_article_inventory_groups_v1 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and x.pass_kind='adjudicator'
  and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

delete from public.source_page_article_inventory_pass_runs_v1 x
using public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where x.job_id=a.job_id and x.pass_kind='adjudicator'
  and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

update public.source_page_article_inventory_jobs_v1 j
set status='queued',lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now()
from public.source_page_inventory_v6_adjudicator_smoke_archive_v7 a
where j.id=a.job_id and a.archive_reason='v6_grounded_adjudicator_smoke_20260810';

update public.inventory_v3_execution_control_v1
set enabled=false,grounded_third_pass_enabled=false,
    reason='paused: rejected V6 adjudicator smoke archived; await V7-quality third pass',updated_at=now()
where singleton=true;
