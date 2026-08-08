create table public.source_image_ingest_provenance_v2(
  source_image_id uuid primary key references public.source_images(id) on delete cascade,
  provenance_version text not null default 'source_ingest_provenance_v2',
  ingest_mode text not null check(ingest_mode in ('legacy_reencoded_derivative','original_preserved','original_and_ocr_derivative')),
  original_storage_path text,
  original_sha256 text,
  ocr_derivative_storage_path text,
  ocr_derivative_sha256 text,
  transform_json jsonb not null default '{}'::jsonb,
  original_available boolean not null default false,
  quality_status text not null check(quality_status in ('passed','legacy_requires_independent_verification','needs_review','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(original_sha256 is null or original_sha256 ~ '^[0-9a-f]{64}$'),
  check(ocr_derivative_sha256 is null or ocr_derivative_sha256 ~ '^[0-9a-f]{64}$'),
  check((ingest_mode='legacy_reencoded_derivative' and not original_available) or (ingest_mode<>'legacy_reencoded_derivative' and original_available))
);
alter table public.source_image_ingest_provenance_v2 enable row level security;
revoke all on public.source_image_ingest_provenance_v2 from public,anon,authenticated,service_role;
grant select on public.source_image_ingest_provenance_v2 to service_role;

insert into public.source_image_ingest_provenance_v2(source_image_id,ingest_mode,ocr_derivative_storage_path,transform_json,original_available,quality_status)
select id,'legacy_reencoded_derivative',storage_path,
       jsonb_build_object('known_client_pipeline','canvas_to_jpeg','jpeg_quality',0.95,'max_side',4200,'original_bytes_not_preserved',true),
       false,'legacy_requires_independent_verification'
from public.source_images
on conflict(source_image_id) do nothing;

create or replace view public.source_image_ingest_provenance_gate_v2
with (security_invoker=true)
as
with fs as (select distinct source_image_id from public.formal_corpus_articles_v1), s as (
 select count(*)::integer source_count,
        count(*) filter(where p.source_image_id is null)::integer missing_provenance,
        count(*) filter(where p.ingest_mode='legacy_reencoded_derivative')::integer legacy_derivative_sources,
        count(*) filter(where p.original_available)::integer original_preserved_sources,
        count(*) filter(where p.quality_status in ('needs_review','failed'))::integer invalid_sources
 from fs left join public.source_image_ingest_provenance_v2 p using(source_image_id)
)
select *,case when missing_provenance=0 and invalid_sources=0 then 'passed' else 'failed' end as provenance_gate from s;
revoke all on public.source_image_ingest_provenance_gate_v2 from public,anon,authenticated;
grant select on public.source_image_ingest_provenance_gate_v2 to service_role;

create or replace view public.formal_source_grounded_articles_v5
with (security_invoker=true)
as
select g.*,
       v.verification_version,v.region_quality_status,v.verification_mode,
       v.canonical_text as verified_canonical_text,v.canonical_text_sha256 as verified_canonical_text_sha256,
       v.numeric_verification_status,v.proper_noun_verification_status,
       v.independent_provider,v.independent_model,v.independent_response_id,v.independent_prompt_sha256,v.independent_response_sha256,
       v.verified_at as ocr_verified_at,
       ip.ingest_mode,ip.original_available,ip.quality_status as ingest_quality_status
from public.formal_source_grounded_articles_v4 g
join public.article_ocr_verifications_v1 v
  on v.article_id=g.article_id and v.source_region_id=g.source_region_id and v.partition_job_id=g.partition_job_id
 and v.source_region_sha256=g.source_region_sha256 and v.source_ocr_sha256=g.current_source_raw_ocr_sha256
join public.source_image_ingest_provenance_v2 ip on ip.source_image_id=g.evidence_source_image_id
where v.quality_status='passed'
  and coalesce(v.canonical_text,'')<>''
  and v.numeric_verification_status in ('passed','not_applicable')
  and v.proper_noun_verification_status in ('passed','not_applicable')
  and v.canonical_text_sha256=encode(extensions.digest(convert_to(v.canonical_text,'UTF8'),'sha256'),'hex')
  and ip.quality_status not in ('needs_review','failed')
  and (ip.ingest_mode<>'legacy_reencoded_derivative' or v.verification_mode in ('crop_ocr_consensus','independent_vision_consensus','manual_verified'));
