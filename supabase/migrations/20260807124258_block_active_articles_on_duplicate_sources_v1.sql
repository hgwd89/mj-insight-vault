create or replace function public.prevent_active_article_on_duplicate_source_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
declare v_dup uuid;begin
  if coalesce(new.article_type,'article')='article'
     and (new.status is null or new.status not in ('deleted','excluded','rejected'))
     and new.source_image_id is not null then
    select duplicate_of_source_image_id into v_dup from public.source_images where id=new.source_image_id;
    if v_dup is not null then
      raise exception using errcode='23514',message='active_article_on_duplicate_source_image_not_allowed',detail=format('source_image_id=%s canonical_source_image_id=%s',new.source_image_id,v_dup);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_active_article_on_duplicate_source_v1 on public.articles;
create trigger trg_prevent_active_article_on_duplicate_source_v1
before insert or update of source_image_id,status,article_type on public.articles
for each row execute function public.prevent_active_article_on_duplicate_source_v1();

create or replace view public.formal_corpus_articles_v1 as
select
    a.id,a.batch_id,a.source_image_id,a.headline,a.article_date,a.article_index,a.ocr_text,a.article_type,
    a.has_table,a.has_chart,a.has_image,a.status,a.manual_analysis,a.created_at,a.updated_at,
    a.duplicate_of_article_id,a.exclusion_reason,a.enrichment_status,a.enrichment_error,
    a.analysis_text_origin,a.source_ocr_sha256,a.analysis_text_sha256,a.reconstruction_model,
    a.reconstruction_prompt_version,a.reconstruction_confidence,a.provenance_status,a.provenance_json
from public.articles a
join public.source_images s on s.id=a.source_image_id
join public.source_publication_date_effective_v1 d on d.source_image_id=a.source_image_id
where (a.status is null or a.status not in ('deleted','excluded','rejected'))
  and coalesce(a.article_type,'')='article'
  and coalesce(btrim(a.ocr_text),'')<>''
  and a.source_image_id is not null
  and s.duplicate_of_source_image_id is null
  and a.provenance_status in ('traceable','legacy_traceable')
  and coalesce(a.source_ocr_sha256,'') ~ '^[0-9a-f]{64}$'
  and coalesce(a.analysis_text_sha256,'') ~ '^[0-9a-f]{64}$'
  and a.analysis_text_origin<>'pending'
  and a.duplicate_of_article_id is null
  and a.article_date_normalized is not null
  and a.article_date_normalization_version='normalize_mj_article_date_v1'
  and d.publication_date_quality_status='passed'
  and d.publication_date=a.article_date_normalized
  and not public.is_hard_advertisement_v1(a.headline,a.analysis_body_clean);