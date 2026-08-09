with recursive r as (
  select id as root,id,duplicate_of_article_id,1 depth,array[id] path
  from public.articles where duplicate_of_article_id is not null
  union all
  select r.root,a.id,a.duplicate_of_article_id,r.depth+1,r.path||a.id
  from r join public.articles a on a.id=r.duplicate_of_article_id
  where r.duplicate_of_article_id is not null and not a.id=any(r.path)
), terminal as (
  select distinct on(root) root,id terminal_id
  from r
  where duplicate_of_article_id is null
  order by root,depth desc
)
update public.articles a
set duplicate_of_article_id=t.terminal_id,
    updated_at=now()
from terminal t
where a.id=t.root and a.duplicate_of_article_id is distinct from t.terminal_id;