update public.articles
set status='excluded',
    duplicate_of_article_id=null,
    exclusion_reason='advertisement_or_exhibitor_recruitment_not_news_v1',
    updated_at=now()
where id = any(array[
 'c41bf27c-362d-42f4-9559-a1910c1bc37a'::uuid,
 '15287104-c278-472b-a13e-ca7b26dbcd35'::uuid,
 'd979ca63-bd84-413f-bc97-1e5e8d67aa39'::uuid,
 'a1f6c8fb-0bc1-454e-88cb-193eec79eeca'::uuid,
 '8a515d8a-295b-401e-87a0-77932222b9c6'::uuid,
 '6a4b68ae-7555-4e08-9804-bf61d96e2f42'::uuid,
 'b33db9a1-564f-45ef-b263-58bbcd8b054d'::uuid
])
and (status is null or status not in ('deleted','excluded','rejected'));