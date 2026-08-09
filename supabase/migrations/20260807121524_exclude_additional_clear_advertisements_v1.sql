update public.articles
set status='excluded',
    duplicate_of_article_id=null,
    exclusion_reason='advertisement_or_house_service_not_news_v1',
    updated_at=now()
where id = any(array[
 '4dc669e0-b741-4148-8a83-ff0d31e08b8e'::uuid,
 '279f1fd1-2440-4180-b14b-71d09c8f513f'::uuid,
 '68dac7b6-942e-4cc8-b6ac-bc1705e00b3e'::uuid,
 '45831e6b-90e7-48bf-a553-6916308c049a'::uuid
])
and (status is null or status not in ('deleted','excluded','rejected'));