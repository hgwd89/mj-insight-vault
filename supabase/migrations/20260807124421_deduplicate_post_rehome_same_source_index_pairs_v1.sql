update public.articles a
set status='excluded',
    duplicate_of_article_id=x.canonical_id,
    exclusion_reason='duplicate_after_exact_source_rehome_review_v1',
    updated_at=now()
from (values
 ('7a625514-9610-4679-b057-fcc8e4a922de'::uuid,'89891658-505e-4765-aa02-b8ec63aaa15a'::uuid),
 ('124a70ce-97d7-4ef6-a18e-24371d595da4'::uuid,'36325dc8-4354-417c-9b9e-afa3d32d3c47'::uuid),
 ('a4c04bca-2ae4-4450-9d14-7e8e24545f5d'::uuid,'05da7ece-f5d1-49a5-9ecf-c3968ebabf14'::uuid),
 ('242617da-88df-40ca-960c-8e588432a6ea'::uuid,'c072d187-4a23-4d70-8ec0-1b9e60db31a8'::uuid),
 ('7f0d294f-657c-4104-9803-7c0f182411c3'::uuid,'f8784131-c7c8-4870-b1a8-44dbbab91bd1'::uuid)
) x(duplicate_id,canonical_id)
where a.id=x.duplicate_id
  and (a.status is null or a.status not in ('deleted','excluded','rejected'));