with recursive chain as (
  select id,duplicate_of_article_id current_id,1 depth
  from public.articles where duplicate_of_article_id is not null
  union all
  select c.id,a.duplicate_of_article_id,c.depth+1
  from chain c
  join public.articles a on a.id=c.current_id
  where a.duplicate_of_article_id is not null and c.depth<20
), ultimate as (
  select distinct on (c.id) c.id,c.current_id ultimate_id,c.depth
  from chain c
  join public.articles a on a.id=c.current_id
  where a.duplicate_of_article_id is null
  order by c.id,c.depth desc
)
update public.articles a
set duplicate_of_article_id=u.ultimate_id,updated_at=now()
from ultimate u
where a.id=u.id and a.duplicate_of_article_id<>u.ultimate_id;