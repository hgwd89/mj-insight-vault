update public.articles a
set status='excluded',duplicate_of_article_id=x.canonical_id,
    exclusion_reason='duplicate_after_same_page_capture_rehome_v1',updated_at=now()
from (values
 ('bf30dbb9-3325-41f7-9491-00e6010f23f4'::uuid,'581907db-1157-4aa0-ab3f-bc16dc8c1820'::uuid),
 ('137b6325-94b6-486c-9828-6a7401fdf7f8'::uuid,'dc5b1586-672b-4369-8ea0-1c8763560dc2'::uuid),
 ('2f222c0e-9866-4d1f-9f65-ab0b990b1d79'::uuid,'daa84bad-bced-4176-89af-80e57eb69641'::uuid)
) x(duplicate_id,canonical_id)
where a.id=x.duplicate_id and (a.status is null or a.status not in ('deleted','excluded','rejected'));

with targets as (
  select a.id,a.source_image_id
  from public.articles a
  where a.id=any(array['30ff9c0d-d814-4105-85b2-8b44571ee089'::uuid,'fdc0eb33-b6d0-400f-b90c-e677c3aa915a'::uuid])
), mx as (
  select t.source_image_id,max(a.article_index)::integer max_idx
  from targets t join public.articles a on a.source_image_id=t.source_image_id
  where a.status is null or a.status not in ('deleted','excluded','rejected')
  group by t.source_image_id
), ranked as (
  select t.id,t.source_image_id,row_number() over(partition by t.source_image_id order by t.id)::integer rn
  from targets t
)
update public.articles a
set original_article_index=coalesce(a.original_article_index,a.article_index),
    article_index=mx.max_idx+r.rn,
    updated_at=now()
from ranked r join mx using(source_image_id)
where a.id=r.id;