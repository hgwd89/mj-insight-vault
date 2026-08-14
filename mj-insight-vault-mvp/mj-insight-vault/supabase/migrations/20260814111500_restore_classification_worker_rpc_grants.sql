-- Restore service-role-only RPC grants required by the authenticated
-- classification worker endpoint. Do not grant these functions to public,
-- anon, or authenticated roles.

revoke all on function public.enqueue_article_classification_v2(boolean, text) from public, anon, authenticated;
revoke all on function public.claim_article_classification_jobs_v2(integer, integer) from public, anon, authenticated;
revoke all on function public.complete_article_classification_job_v2(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_article_classification_job_v2(uuid, uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.enqueue_article_classification_v2(boolean, text) to postgres, service_role;
grant execute on function public.claim_article_classification_jobs_v2(integer, integer) to postgres, service_role;
grant execute on function public.complete_article_classification_job_v2(uuid, uuid, jsonb, jsonb) to postgres, service_role;
grant execute on function public.fail_article_classification_job_v2(uuid, uuid, text, boolean) to postgres, service_role;
