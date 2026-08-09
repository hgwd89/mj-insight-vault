create table if not exists public.clean_embedding_duplicate_audit_runs_v1 (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null default 'all' check(scope_type in ('all','category')),
  scope_query text,
  corpus_article_count integer not null,
  corpus_source_truth_fingerprint text not null,
  strict_embedding_count integer not null,
  detection_version text not null default 'clean_embedding_duplicate_audit_v1',
  status text not null default 'queued' check(status in ('queued','running','completed','failed')),
  candidate_count integer not null default 0,
  distinct_count integer not null default 0,
  duplicate_count integer not null default 0,
  unresolved_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check(candidate_count>=0 and distinct_count>=0 and duplicate_count>=0 and unresolved_count>=0),
  check(candidate_count=distinct_count+duplicate_count+unresolved_count)
);

create unique index if not exists clean_embedding_duplicate_audit_runs_v1_current_uidx
on public.clean_embedding_duplicate_audit_runs_v1(scope_type,coalesce(scope_query,''),corpus_source_truth_fingerprint,detection_version)
where status in ('queued','running','completed');

create table if not exists public.clean_embedding_duplicate_candidates_v1 (
  run_id uuid not null references public.clean_embedding_duplicate_audit_runs_v1(id) on delete cascade,
  article_id_a uuid not null references public.articles(id) on delete cascade,
  article_id_b uuid not null references public.articles(id) on delete cascade,
  detection_reason text not null,
  semantic_similarity double precision,
  headline_similarity double precision,
  disposition text check(disposition is null or disposition in ('distinct','duplicate')),
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(run_id,article_id_a,article_id_b),
  check(article_id_a<article_id_b)
);

create index if not exists clean_embedding_duplicate_candidates_v1_disposition_idx
on public.clean_embedding_duplicate_candidates_v1(run_id,disposition);

create or replace view public.formal_corpus_duplicate_gate_v4 as
with p as (
  select article_count::integer formal_article_count,source_truth_fingerprint
  from public.formal_corpus_scope_proof_v3('all','')
), e as (
  select formal_article_count,strict_embedding_count,embedding_gate,gate_reason embedding_gate_reason
  from public.article_embedding_quality_gate_v2
), current_run as (
  select r.*
  from public.clean_embedding_duplicate_audit_runs_v1 r
  join p on r.scope_type='all' and coalesce(r.scope_query,'')=''
        and r.corpus_source_truth_fingerprint=p.source_truth_fingerprint
        and r.corpus_article_count=p.formal_article_count
  where r.detection_version='clean_embedding_duplicate_audit_v1'
  order by r.created_at desc
  limit 1
)
select p.formal_article_count,p.source_truth_fingerprint,e.strict_embedding_count,e.embedding_gate,
       r.id audit_run_id,r.status audit_run_status,
       coalesce(r.candidate_count,0) duplicate_candidate_pair_count,
       coalesce(r.distinct_count,0) reviewed_distinct_pair_count,
       coalesce(r.duplicate_count,0) reviewed_duplicate_pair_count,
       coalesce(r.unresolved_count,0) unresolved_pair_count,
       case
         when e.embedding_gate<>'passed' then 'failed'
         when r.id is null then 'failed'
         when r.strict_embedding_count<>p.formal_article_count then 'failed'
         when r.status<>'completed' then 'failed'
         when r.duplicate_count>0 then 'failed'
         when r.unresolved_count>0 then 'failed'
         else 'passed'
       end duplicate_gate,
       case
         when e.embedding_gate<>'passed' then 'strict_clean_embedding_required'
         when r.id is null then 'current_duplicate_audit_run_required'
         when r.strict_embedding_count<>p.formal_article_count then 'duplicate_audit_embedding_count_mismatch'
         when r.status='failed' then coalesce(r.error_message,'duplicate_audit_failed')
         when r.status<>'completed' then 'duplicate_audit_not_completed'
         when r.duplicate_count>0 then 'duplicate_candidate_must_be_removed_from_formal_corpus'
         when r.unresolved_count>0 then 'duplicate_candidates_require_review'
         else 'passed'
       end gate_reason
from p cross join e left join current_run r on true;