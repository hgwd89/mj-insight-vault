begin;

alter table public.article_classification_jobs_v4
  add column if not exists active_pass_kind text,
  add column if not exists ocr_receipt_id uuid references public.verified_ocr_corpus_receipts_v5(id),
  add column if not exists ocr_verification_set_fingerprint text,
  add column if not exists duplicate_audit_run_id uuid references public.source_grounded_duplicate_audit_runs_v5(id);

alter table public.article_profiles_v4
  add column if not exists ocr_receipt_id uuid references public.verified_ocr_corpus_receipts_v5(id),
  add column if not exists ocr_verification_set_fingerprint text,
  add column if not exists duplicate_audit_run_id uuid references public.source_grounded_duplicate_audit_runs_v5(id);

create table if not exists public.article_classification_stage_v6(
  job_id uuid not null references public.article_classification_jobs_v4(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('classifier','critic')),
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(job_id,pass_kind)
);
alter table public.article_classification_stage_v6 enable row level security;
revoke all on public.article_classification_stage_v6 from public,anon,authenticated,service_role;
grant select on public.article_classification_stage_v6 to service_role;

create or replace function public.verified_article_anchor_present_v6(p_article_id uuid,p_anchor text)
returns boolean
language sql
stable security definer
set search_path=pg_catalog,public
as $function$
  select coalesce(char_length(btrim(p_anchor))>=6,false)
     and exists(
       select 1 from public.formal_verified_article_text_v5 v
       where v.article_id=p_article_id
         and position(lower(btrim(p_anchor)) in lower(v.analysis_text))>0
     );
$function$;
revoke all on function public.verified_article_anchor_present_v6(uuid,text) from public,anon,authenticated;
grant execute on function public.verified_article_anchor_present_v6(uuid,text) to service_role;

create view public.formal_article_classification_input_v6
with (security_invoker=true)
as
with catalog as (
  select public.analysis_category_catalog_fingerprint_v4() category_catalog_fingerprint,
         coalesce(jsonb_agg(jsonb_build_object(
           'id',id,'name_ja',name_ja,'description',coalesce(description,''),'keywords',keywords
         ) order by id),'[]'::jsonb) category_catalog_json
  from public.analysis_categories
  where is_active=true
), dg as (
  select audit_run_id
  from public.source_grounded_duplicate_gate_v6
  where duplicate_gate='passed'
), ocr as (
  select * from public.current_verified_ocr_corpus_receipt_v5
)
select v.article_id,v.source_region_id,v.partition_job_id,
       v.source_region_sha256,v.current_source_raw_ocr_sha256,
       ocr.freeze_receipt_id,ocr.id ocr_receipt_id,ocr.verification_set_fingerprint ocr_verification_set_fingerprint,
       dg.audit_run_id duplicate_audit_run_id,
       c.category_catalog_fingerprint,c.category_catalog_json,
       v.analysis_text verified_text,v.analysis_text_sha256 verified_text_sha256,
       jsonb_build_object('verified_crop_ocr_text',v.analysis_text,'verified_text_sha256',v.analysis_text_sha256) blocks_json,
       encode(extensions.digest(convert_to(jsonb_build_object(
         'article_id',v.article_id,
         'verified_text_sha256',v.analysis_text_sha256,
         'ocr_verification_set_fingerprint',ocr.verification_set_fingerprint,
         'category_catalog_fingerprint',c.category_catalog_fingerprint,
         'duplicate_audit_run_id',dg.audit_run_id
       )::text,'UTF8'),'sha256'),'hex') classification_input_sha256
from public.formal_verified_article_text_v5 v
cross join catalog c
cross join dg
cross join ocr;
revoke all on public.formal_article_classification_input_v6 from public,anon,authenticated;
grant select on public.formal_article_classification_input_v6 to service_role;

commit;