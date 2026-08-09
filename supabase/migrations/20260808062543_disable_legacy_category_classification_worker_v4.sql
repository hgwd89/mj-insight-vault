begin;
revoke execute on function public.claim_article_classification_jobs_v4(integer,integer) from service_role;
revoke execute on function public.complete_article_classification_job_v4(uuid,uuid,text,text,jsonb,jsonb) from service_role;
revoke execute on function public.enqueue_article_classification_jobs_v4() from service_role;
revoke execute on function public.fail_article_classification_job_v4(uuid,uuid,text,boolean,text) from service_role;
revoke execute on function public.renew_article_classification_job_lease_v4(uuid,uuid,integer) from service_role;
revoke execute on function public.requeue_article_classification_job_v4(uuid) from service_role;
commit;