update public.articles a
set status='excluded',duplicate_of_article_id=x.canonical_id,
    exclusion_reason='duplicate_after_reviewed_near_source_rehome_v1',updated_at=now()
from (values
 ('903f88c2-9d82-4273-a630-59c5b7a8fa15'::uuid,'9f012782-8fea-4e2d-85f3-6c01ea172c07'::uuid),
 ('7e9906fe-5447-4c00-a415-3736712eeea8'::uuid,'b6d2968d-c362-4cf9-907e-4af7577a928c'::uuid),
 ('06e66e9a-0f0e-48aa-ad03-abd3ac6c2858'::uuid,'23a1e20c-e335-41b5-9e1f-def6ba0e54fe'::uuid),
 ('2aa98e49-26ef-4427-8cd4-0d67a7f67b94'::uuid,'07f08f30-6313-40d9-8778-d9f71366a047'::uuid),
 ('a93a40c8-7c02-4a2b-8d34-ec941c816d32'::uuid,'d601b08f-6f2b-482e-a0cc-f84f7f44623d'::uuid)
) x(duplicate_id,canonical_id)
where a.id=x.duplicate_id and (a.status is null or a.status not in ('deleted','excluded','rejected'));