alter table public.article_embeddings add column if not exists embedding_version text;
alter table public.article_embeddings add column if not exists source_analysis_text_sha256 text;
alter table public.article_embeddings add column if not exists quality_status text;
alter table public.article_embeddings add column if not exists updated_at timestamptz not null default now();

update public.article_embeddings e
set embedding_version='legacy_article_text_3500_v1',
    source_analysis_text_sha256=a.analysis_text_sha256,
    quality_status=case
      when e.embedding_text like '%【OCR照合メモ】%' then 'legacy_page_ocr_contaminated'
      when length(coalesce(a.ocr_text,''))>3500 then 'legacy_truncated'
      else 'legacy_unverified'
    end,
    updated_at=now()
from public.articles a
where a.id=e.article_id
  and e.embedding_text=('見出し: '||coalesce(a.headline,'')||E'\n記事種別: '||coalesce(a.article_type,'')||E'\n本文: '||left(coalesce(a.ocr_text,''),3500));

create or replace view public.formal_article_embeddings_v2
with (security_invoker=true)
as
select e.id,e.article_id,e.embedding_text,e.embedding_vector,e.embedding_version,e.source_analysis_text_sha256,e.quality_status,e.created_at,e.updated_at
from public.article_embeddings e
join public.formal_corpus_articles_v1 a on a.id=e.article_id
where e.embedding_version='article_semantic_clean_v2'
  and e.quality_status='passed'
  and e.source_analysis_text_sha256=a.analysis_text_sha256;

create or replace view public.article_embedding_quality_gate_v1
with (security_invoker=true)
as
with formal as (select id,analysis_text_sha256 from public.formal_corpus_articles_v1), stats as (
  select count(*)::integer formal_article_count,
         count(e.*)::integer any_embedding_count,
         count(e.*) filter(where e.embedding_version='legacy_article_text_3500_v1')::integer legacy_embedding_count,
         count(e.*) filter(where e.quality_status='legacy_page_ocr_contaminated')::integer page_ocr_contaminated_count,
         count(e.*) filter(where e.quality_status='legacy_truncated')::integer legacy_truncated_count,
         count(v.*)::integer strict_embedding_count
  from formal f
  left join public.article_embeddings e on e.article_id=f.id
  left join public.formal_article_embeddings_v2 v on v.article_id=f.id
)
select *,
       case when formal_article_count>0 and strict_embedding_count=formal_article_count then 'passed' else 'failed' end embedding_gate,
       case when formal_article_count=0 then 'no_formal_articles'
            when strict_embedding_count<>formal_article_count then 'strict_embedding_rebuild_required'
            else 'passed' end gate_reason
from stats;

revoke all on public.formal_article_embeddings_v2 from public,anon,authenticated;
revoke all on public.article_embedding_quality_gate_v1 from public,anon,authenticated;
grant select on public.formal_article_embeddings_v2 to postgres,service_role;
grant select on public.article_embedding_quality_gate_v1 to postgres,service_role;