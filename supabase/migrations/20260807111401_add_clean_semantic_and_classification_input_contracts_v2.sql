alter table public.article_embeddings add column if not exists source_clean_body_sha256 text;
alter table public.article_embeddings add column if not exists embedding_input_sha256 text;

create or replace view public.formal_article_embedding_input_v2
with (security_invoker=true)
as
select v.article_id,
       ('見出し: '||coalesce(v.headline,'')||E'\n本文: '||v.analysis_body) embedding_input_text,
       encode(extensions.digest(convert_to('見出し: '||coalesce(v.headline,'')||E'\n本文: '||v.analysis_body,'UTF8'),'sha256'),'hex') embedding_input_sha256,
       v.analysis_body_sha256 source_clean_body_sha256
from public.formal_article_analysis_text_v2 v;

revoke all on public.formal_article_embedding_input_v2 from public,anon,authenticated;
grant select on public.formal_article_embedding_input_v2 to postgres,service_role;

create or replace view public.formal_article_embeddings_v3
with (security_invoker=true)
as
select e.id,e.article_id,e.embedding_text,e.embedding_vector,e.embedding_version,
       e.source_analysis_text_sha256,e.source_clean_body_sha256,e.embedding_input_sha256,
       e.quality_status,e.created_at,e.updated_at
from public.article_embeddings e
join public.formal_article_embedding_input_v2 i on i.article_id=e.article_id
where e.embedding_version='article_semantic_clean_v2'
  and e.quality_status='passed'
  and e.source_clean_body_sha256=i.source_clean_body_sha256
  and e.embedding_input_sha256=i.embedding_input_sha256
  and e.embedding_text=i.embedding_input_text
  and e.embedding_vector is not null;

create or replace view public.article_embedding_quality_gate_v2
with (security_invoker=true)
as
with formal as (select article_id from public.formal_article_analysis_text_v2), stats as (
  select count(*)::integer formal_article_count,
         count(e.*)::integer any_embedding_count,
         count(e.*) filter(where e.embedding_version='legacy_article_text_3500_v1')::integer legacy_embedding_count,
         count(e.*) filter(where e.quality_status='legacy_page_ocr_contaminated')::integer page_ocr_contaminated_count,
         count(v.*)::integer strict_embedding_count
  from formal f
  left join public.article_embeddings e on e.article_id=f.article_id
  left join public.formal_article_embeddings_v3 v on v.article_id=f.article_id
)
select *,case when formal_article_count>0 and strict_embedding_count=formal_article_count then 'passed' else 'failed' end embedding_gate,
       case when formal_article_count=0 then 'no_formal_articles' when strict_embedding_count<>formal_article_count then 'strict_clean_embedding_rebuild_required' else 'passed' end gate_reason
from stats;

revoke all on public.formal_article_embeddings_v3 from public,anon,authenticated;
revoke all on public.article_embedding_quality_gate_v2 from public,anon,authenticated;
grant select on public.formal_article_embeddings_v3 to postgres,service_role;
grant select on public.article_embedding_quality_gate_v2 to postgres,service_role;

alter table public.article_classification_jobs add column if not exists source_clean_body_sha256 text;
alter table public.article_profiles add column if not exists source_clean_body_sha256 text;
alter table public.article_category_memberships add column if not exists source_clean_body_sha256 text;

create or replace view public.formal_category_memberships_v3
with (security_invoker=true)
as
select m.*
from public.article_category_memberships m
join public.formal_article_analysis_text_v2 v on v.article_id=m.article_id
join public.analysis_categories c on c.id=m.category_id and c.is_active=true
where m.source='article_category_profile_v3_clean_body'
  and m.source_clean_body_sha256=v.analysis_body_sha256;

create or replace view public.category_classification_gate_v3
with (security_invoker=true)
as
with formal as (select article_id,analysis_body_sha256 from public.formal_article_analysis_text_v2), profiled as (
  select distinct p.article_id
  from public.article_profiles p join formal f on f.article_id=p.article_id
  where p.profile_model='article_category_profile_v3_clean_body'
    and p.source_clean_body_sha256=f.analysis_body_sha256
), categorized as (
  select distinct m.article_id from public.formal_category_memberships_v3 m
), invalid_memberships as (
  select count(*)::integer n
  from public.article_category_memberships m
  join formal f on f.article_id=m.article_id
  left join public.analysis_categories c on c.id=m.category_id and c.is_active=true
  where m.source='article_category_profile_v3_clean_body'
    and m.source_clean_body_sha256=f.analysis_body_sha256
    and c.id is null
)
select (select count(*)::integer from formal) formal_article_count,
       (select count(*)::integer from profiled) profiled_article_count,
       (select count(*)::integer from categorized) categorized_article_count,
       (select count(*)::integer from formal f left join profiled p on p.article_id=f.article_id where p.article_id is null) unprofiled_article_count,
       (select count(*)::integer from formal f left join categorized c on c.article_id=f.article_id where c.article_id is null) uncategorized_article_count,
       (select n from invalid_memberships) invalid_membership_count,
       case when (select count(*) from formal)=0 then 'failed'
            when (select count(*) from formal)<>(select count(*) from profiled) then 'failed'
            when (select count(*) from formal)<>(select count(*) from categorized) then 'failed'
            when (select n from invalid_memberships)>0 then 'failed'
            else 'passed' end category_classification_gate,
       case when (select count(*) from formal)=0 then 'no_formal_articles'
            when (select count(*) from formal)<>(select count(*) from profiled) then 'strict_clean_profiles_missing'
            when (select count(*) from formal)<>(select count(*) from categorized) then 'strict_clean_memberships_missing'
            when (select n from invalid_memberships)>0 then 'inactive_or_missing_category_memberships_exist'
            else 'passed' end gate_reason;

revoke all on public.formal_category_memberships_v3 from public,anon,authenticated;
revoke all on public.category_classification_gate_v3 from public,anon,authenticated;
grant select on public.formal_category_memberships_v3 to postgres,service_role;
grant select on public.category_classification_gate_v3 to postgres,service_role;