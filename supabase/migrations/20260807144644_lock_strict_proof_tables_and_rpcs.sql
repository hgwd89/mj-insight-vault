alter table public.source_page_partition_jobs_v3 enable row level security;
alter table public.source_page_partition_proposals_v3 enable row level security;
alter table public.article_source_grounding_reviews_v3 enable row level security;
alter table public.source_page_primary_capture_v1 enable row level security;
alter table public.source_page_capture_map_v1 enable row level security;
alter table public.formal_corpus_freeze_receipts_v1 enable row level security;

revoke all on table public.source_page_partition_jobs_v3 from anon, authenticated;
revoke all on table public.source_page_partition_proposals_v3 from anon, authenticated;
revoke all on table public.article_source_grounding_reviews_v3 from anon, authenticated;
revoke all on table public.source_page_primary_capture_v1 from anon, authenticated;
revoke all on table public.source_page_capture_map_v1 from anon, authenticated;
revoke all on table public.formal_corpus_freeze_receipts_v1 from anon, authenticated;

grant all on table public.source_page_partition_jobs_v3 to service_role;
grant all on table public.source_page_partition_proposals_v3 to service_role;
grant all on table public.article_source_grounding_reviews_v3 to service_role;
grant all on table public.source_page_primary_capture_v1 to service_role;
grant all on table public.source_page_capture_map_v1 to service_role;
grant all on table public.formal_corpus_freeze_receipts_v1 to service_role;

revoke execute on function public.enqueue_source_page_partition_jobs_v3() from public, anon, authenticated;
revoke execute on function public.claim_source_page_partition_job_v3(integer) from public, anon, authenticated;
revoke execute on function public.get_source_page_partition_job_input_v3(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.replace_source_page_partition_proposals_v3(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke execute on function public.fail_source_page_partition_job_v3(uuid,uuid,text,boolean,text) from public, anon, authenticated;
revoke execute on function public.requeue_source_page_partition_job_v3(uuid) from public, anon, authenticated;
revoke execute on function public.finalize_source_page_partition_job_v3(uuid,uuid,text,text) from public, anon, authenticated;
revoke execute on function public.ensure_source_page_capture_map_v1() from public, anon, authenticated;
revoke execute on function public.validate_source_page_partition_proposal_v3() from public, anon, authenticated;
revoke execute on function public.validate_article_source_grounding_review_v3() from public, anon, authenticated;

grant execute on function public.enqueue_source_page_partition_jobs_v3() to service_role;
grant execute on function public.claim_source_page_partition_job_v3(integer) to service_role;
grant execute on function public.get_source_page_partition_job_input_v3(uuid,uuid) to service_role;
grant execute on function public.replace_source_page_partition_proposals_v3(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.fail_source_page_partition_job_v3(uuid,uuid,text,boolean,text) to service_role;
grant execute on function public.requeue_source_page_partition_job_v3(uuid) to service_role;
grant execute on function public.finalize_source_page_partition_job_v3(uuid,uuid,text,text) to service_role;
grant execute on function public.ensure_source_page_capture_map_v1() to service_role;
grant execute on function public.validate_source_page_partition_proposal_v3() to service_role;
grant execute on function public.validate_article_source_grounding_review_v3() to service_role;