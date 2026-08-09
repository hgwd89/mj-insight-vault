create or replace view public.formal_month_articles_v3
with (security_invoker=true)
as
select f.id,f.batch_id,f.source_image_id,f.headline,f.article_date,
  public.formal_month_key_v1(f.article_date) month_key,
  f.article_index,f.ocr_text,f.article_type,f.status,f.created_at,f.updated_at,
  f.analysis_text_origin,f.source_ocr_sha256,f.analysis_text_sha256,
  f.reconstruction_model,f.reconstruction_prompt_version,f.reconstruction_confidence,
  f.provenance_status,f.provenance_json
from public.formal_corpus_articles_v1 f;
revoke all on public.formal_month_articles_v3 from anon,authenticated;
grant select on public.formal_month_articles_v3 to postgres,service_role;