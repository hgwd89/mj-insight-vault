with mutual as (
  select a.id a_id,b.id b_id,a.status a_status,b.status b_status
  from public.articles a join public.articles b on b.id=a.duplicate_of_article_id
  where b.duplicate_of_article_id=a.id and a.id<b.id
), canon as (
  select case when a_status='ocr_done' and b_status='excluded' then a_id when b_status='ocr_done' and a_status='excluded' then b_id end canonical_id
  from mutual
  where (a_status='ocr_done' and b_status='excluded') or (b_status='ocr_done' and a_status='excluded')
)
update public.articles a
set duplicate_of_article_id=null,
    exclusion_reason=null,
    updated_at=now()
from canon c
where a.id=c.canonical_id;