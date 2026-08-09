alter table public.articles add column if not exists original_article_index integer;

update public.articles
set original_article_index=article_index
where original_source_image_id is not null and original_article_index is null;

with colliding_sources as (
  select source_image_id,article_index
  from public.formal_corpus_articles_v1
  group by source_image_id,article_index
  having count(*)>1
), targets as (
  select f.id,f.source_image_id,
         row_number() over(partition by f.source_image_id order by f.article_index,f.id)::integer rn
  from public.formal_corpus_articles_v1 f
  join colliding_sources c using(source_image_id,article_index)
  join public.articles a on a.id=f.id
  where a.original_source_image_id is not null
), mx as (
  select source_image_id,max(article_index)::integer max_idx
  from public.articles
  where (status is null or status not in ('deleted','excluded','rejected')) and article_index is not null
  group by source_image_id
)
update public.articles a
set article_index=mx.max_idx+t.rn,
    updated_at=now()
from targets t join mx using(source_image_id)
where a.id=t.id;