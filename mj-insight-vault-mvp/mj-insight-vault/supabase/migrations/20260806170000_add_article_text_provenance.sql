-- Separate the article analysis text from its OCR source provenance.
-- A formal article must be traceable to a concrete source image OCR payload.

alter table public.articles
  add column if not exists analysis_text_origin text not null default 'pending',
  add column if not exists source_ocr_sha256 text,
  add column if not exists analysis_text_sha256 text,
  add column if not exists reconstruction_model text,
  add column if not exists reconstruction_prompt_version text,
  add column if not exists reconstruction_confidence text,
  add column if not exists provenance_status text not null default 'pending',
  add column if not exists provenance_json jsonb not null default '{}'::jsonb;

alter table public.articles drop constraint if exists articles_analysis_text_origin_check;
alter table public.articles add constraint articles_analysis_text_origin_check
  check (analysis_text_origin in (
    'pending',
    'vision_llm_reconstruction',
    'text_llm_segmentation',
    'raw_ocr_fallback',
    'legacy_vision_llm_reconstruction',
    'legacy_unclassified_text'
  ));

alter table public.articles drop constraint if exists articles_provenance_status_check;
alter table public.articles add constraint articles_provenance_status_check
  check (provenance_status in ('pending', 'traceable', 'legacy_traceable', 'failed'));

alter table public.articles drop constraint if exists articles_reconstruction_confidence_check;
alter table public.articles add constraint articles_reconstruction_confidence_check
  check (reconstruction_confidence is null or reconstruction_confidence in ('high', 'medium', 'low', 'unknown'));

-- Existing records are traceable because the raw OCR remains on source_images.
update public.articles a
set analysis_text_origin = case
      when a.ocr_text like '【GPT記事構造化】%' then 'legacy_vision_llm_reconstruction'
      else 'legacy_unclassified_text'
    end,
    source_ocr_sha256 = encode(extensions.digest(convert_to(s.ocr_text_raw, 'UTF8'), 'sha256'), 'hex'),
    analysis_text_sha256 = encode(extensions.digest(convert_to(a.ocr_text, 'UTF8'), 'sha256'), 'hex'),
    reconstruction_model = case
      when a.ocr_text like '【GPT記事構造化】%' then 'legacy_runtime_vision_model_unknown'
      else 'legacy_runtime_text_path_unknown'
    end,
    reconstruction_prompt_version = case
      when a.ocr_text like '【GPT記事構造化】%' then 'legacy_article_structure_pre_provenance_v1'
      else 'legacy_text_path_pre_provenance_v1'
    end,
    reconstruction_confidence = coalesce(
      nullif(substring(a.ocr_text from '【全体信頼度】(high|medium|low)'), ''),
      'unknown'
    ),
    provenance_status = 'legacy_traceable',
    provenance_json = jsonb_build_object(
      'backfilled', true,
      'backfill_method', 'source_image_raw_ocr_and_persisted_analysis_text_sha256',
      'source_image_id', a.source_image_id,
      'source_ocr_available', true,
      'model_exactly_known', false,
      'prompt_exactly_known', false
    ),
    updated_at = now()
from public.source_images s
where s.id = a.source_image_id
  and coalesce(btrim(s.ocr_text_raw), '') <> ''
  and coalesce(btrim(a.ocr_text), '') <> ''
  and (
    a.provenance_status = 'pending'
    or coalesce(a.source_ocr_sha256, '') = ''
    or coalesce(a.analysis_text_sha256, '') = ''
  );

create index if not exists articles_provenance_status_idx
  on public.articles(provenance_status, created_at)
  where (status is null or status not in ('deleted', 'excluded', 'rejected'));

create index if not exists articles_source_ocr_sha256_idx
  on public.articles(source_ocr_sha256)
  where source_ocr_sha256 is not null;

create or replace view public.formal_corpus_articles_v1
with (security_invoker = true)
as
select a.*
from public.articles a
where (a.status is null or a.status not in ('deleted', 'excluded', 'rejected'))
  and coalesce(a.article_type, '') = 'article'
  and coalesce(btrim(a.ocr_text), '') <> ''
  and a.source_image_id is not null
  and a.provenance_status in ('traceable', 'legacy_traceable')
  and coalesce(a.source_ocr_sha256, '') ~ '^[0-9a-f]{64}$'
  and coalesce(a.analysis_text_sha256, '') ~ '^[0-9a-f]{64}$'
  and a.analysis_text_origin <> 'pending';

revoke all on public.formal_corpus_articles_v1 from public, anon, authenticated;
grant select on public.formal_corpus_articles_v1 to postgres, service_role;

create or replace view public.article_provenance_audit_v1
with (security_invoker = true)
as
select
  a.id as article_id,
  a.source_image_id,
  a.status,
  a.article_type,
  a.analysis_text_origin,
  a.reconstruction_model,
  a.reconstruction_prompt_version,
  a.reconstruction_confidence,
  a.provenance_status,
  a.source_ocr_sha256,
  a.analysis_text_sha256,
  encode(extensions.digest(convert_to(coalesce(s.ocr_text_raw, ''), 'UTF8'), 'sha256'), 'hex') = a.source_ocr_sha256 as source_ocr_hash_matches,
  encode(extensions.digest(convert_to(coalesce(a.ocr_text, ''), 'UTF8'), 'sha256'), 'hex') = a.analysis_text_sha256 as analysis_text_hash_matches,
  coalesce(btrim(s.ocr_text_raw), '') <> '' as source_ocr_available,
  a.provenance_json
from public.articles a
left join public.source_images s on s.id = a.source_image_id;

revoke all on public.article_provenance_audit_v1 from public, anon, authenticated;
grant select on public.article_provenance_audit_v1 to postgres, service_role;
