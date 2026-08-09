create or replace view public.formal_month_article_counts_v1
with (security_invoker=true)
as
select public.formal_month_key_v1(article_date) month_key,count(*)::integer article_count
from public.formal_corpus_articles_v1
group by public.formal_month_key_v1(article_date);

create or replace view public.monthly_rollup_gate_v3
with (security_invoker=true)
as
select r.id,r.month_key,r.status,r.article_count,
  coalesce(c.article_count,0) expected_article_count,
  public.formal_monthly_source_fingerprint_v3(r.month_key) expected_source_fingerprint,
  public.monthly_rollup_v3_payload_integrity_v1(r.month_key,r.article_count,r.article_ids,r.summary_json) integrity_ok,
  coalesce(r.summary_json->>'generation_method','') generation_method,
  coalesce(r.summary_json->>'worker_version','') worker_version,
  coalesce(r.summary_json->>'prompt_version','') prompt_version,
  coalesce(r.summary_json->>'validation_version','') validation_version,
  r.generated_at,r.error_message,r.updated_at
from public.monthly_rollups r
left join public.formal_month_article_counts_v1 c on c.month_key=r.month_key;

revoke all on public.formal_month_article_counts_v1 from anon,authenticated;
revoke all on public.monthly_rollup_gate_v3 from anon,authenticated;
grant select on public.formal_month_article_counts_v1 to postgres,service_role;
grant select on public.monthly_rollup_gate_v3 to postgres,service_role;