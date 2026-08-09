alter table public.article_embeddings_v4
  add column embedding_job_id uuid not null references public.article_embedding_jobs_v4(id);

alter table public.article_profiles_v4
  add column classification_job_id uuid not null references public.article_classification_jobs_v4(id);

create or replace function public.complete_article_embedding_job_v4(p_job_id uuid,p_lease_token uuid,p_embedding_vector_text text,p_embedding_model text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.article_embedding_jobs_v4%rowtype;
  i public.formal_article_embedding_input_v4%rowtype;
  v public.vector(1536);
begin
  select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'embedding_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'embedding_v4_job_lease_invalid'; end if;
  select * into i from public.formal_article_embedding_input_v4 where article_id=j.article_id;
  if not found then raise exception 'embedding_v4_input_not_current'; end if;
  if i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.embedding_input_sha256<>j.embedding_input_sha256 or i.embedding_input_text<>j.embedding_input_text then raise exception 'embedding_v4_input_stale'; end if;
  if coalesce(btrim(p_embedding_model),'')='' then raise exception 'embedding_v4_model_required'; end if;
  begin v:=p_embedding_vector_text::public.vector(1536); exception when others then raise exception 'embedding_v4_vector_invalid'; end;
  if v is null then raise exception 'embedding_v4_vector_missing'; end if;

  insert into public.article_embeddings_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,embedding_input_text,embedding_input_sha256,embedding_vector,embedding_model,embedding_version,quality_status,embedding_job_id,updated_at)
  values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.embedding_input_text,j.embedding_input_sha256,v,left(p_embedding_model,200),j.embedding_version,'passed',j.id,now())
  on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256)
  do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,embedding_input_text=excluded.embedding_input_text,embedding_vector=excluded.embedding_vector,embedding_model=excluded.embedding_model,quality_status='passed',embedding_job_id=excluded.embedding_job_id,updated_at=now();

  update public.article_embedding_jobs_v4 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','job_id',j.id,'article_id',j.article_id);
end $$;

create or replace view public.formal_article_embeddings_v4 as
select e.*
from public.article_embeddings_v4 e
join public.formal_article_embedding_input_v4 i on i.article_id=e.article_id
join public.article_embedding_jobs_v4 j on j.id=e.embedding_job_id and j.status='completed'
where e.embedding_version='article_semantic_source_region_v4'
  and e.quality_status='passed'
  and e.article_id=j.article_id
  and e.freeze_receipt_id=i.freeze_receipt_id and e.freeze_receipt_id=j.freeze_receipt_id
  and e.source_region_id=i.source_region_id and e.source_region_id=j.source_region_id
  and e.source_partition_job_id=i.partition_job_id and e.source_partition_job_id=j.source_partition_job_id
  and e.source_region_sha256=i.source_region_sha256 and e.source_region_sha256=j.source_region_sha256
  and e.source_ocr_sha256=i.current_source_raw_ocr_sha256 and e.source_ocr_sha256=j.source_ocr_sha256
  and e.embedding_input_sha256=i.embedding_input_sha256 and e.embedding_input_sha256=j.embedding_input_sha256
  and e.embedding_input_text=i.embedding_input_text and e.embedding_input_text=j.embedding_input_text;

create or replace function public.complete_article_classification_job_v4(p_job_id uuid,p_lease_token uuid,p_classifier_model text,p_critic_model text,p_classifier jsonb,p_critic jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.article_classification_jobs_v4%rowtype;
  i public.formal_article_classification_input_v4%rowtype;
  v_status_a text;v_status_b text;v_primary_a text;v_primary_b text;v_conf_a numeric;v_conf_b numeric;v_members_a text[];v_members_b text[];
  v_profile_id uuid;v_reason text;v_anchor text;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'classification_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'classification_v4_job_lease_invalid'; end if;
  select * into i from public.formal_article_classification_input_v4 where article_id=j.article_id;
  if not found or i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.category_catalog_fingerprint<>j.category_catalog_fingerprint or i.classification_input_sha256<>j.classification_input_sha256 then raise exception 'classification_v4_input_stale'; end if;
  if coalesce(btrim(p_classifier_model),'')='' or coalesce(btrim(p_critic_model),'')='' or p_classifier_model=p_critic_model then raise exception 'classification_v4_distinct_models_required'; end if;

  v_status_a:=p_classifier->>'classification_status';v_status_b:=p_critic->>'classification_status';v_primary_a:=nullif(btrim(p_classifier->>'primary_category'),'');v_primary_b:=nullif(btrim(p_critic->>'primary_category'),'');v_conf_a:=coalesce((p_classifier->>'confidence')::numeric,0);v_conf_b:=coalesce((p_critic->>'confidence')::numeric,0);
  select coalesce(array_agg(category_id order by category_id),'{}'::text[]) into v_members_a from (select distinct x.category_id from jsonb_to_recordset(coalesce(p_classifier->'memberships','[]'::jsonb)) x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)) q;
  select coalesce(array_agg(category_id order by category_id),'{}'::text[]) into v_members_b from (select distinct x.category_id from jsonb_to_recordset(coalesce(p_critic->'memberships','[]'::jsonb)) x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)) q;

  if v_status_a not in ('categorized','no_matching_category') or v_status_b not in ('categorized','no_matching_category') or v_status_a<>v_status_b or v_primary_a is distinct from v_primary_b or v_members_a<>v_members_b or least(v_conf_a,v_conf_b)<0.70 then
    update public.article_classification_jobs_v4 set status='needs_review',result_json=jsonb_build_object('classifier',p_classifier,'critic',p_critic),last_error_class='classification_disagreement',error_message='dual classifier disagreement or confidence below 0.70',lease_token=null,lease_expires_at=null,next_retry_at=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review','reason','dual_classifier_disagreement_or_low_confidence');
  end if;

  if v_status_a='no_matching_category' then
    if v_primary_a is not null or cardinality(v_members_a)<>0 then raise exception 'classification_v4_no_match_must_have_no_memberships'; end if;
  else
    if v_primary_a is null or cardinality(v_members_a)<1 or not(v_primary_a=any(v_members_a)) then raise exception 'classification_v4_primary_membership_invalid'; end if;
    if exists(select 1 from unnest(v_members_a) c left join public.analysis_categories ac on ac.id=c and ac.is_active=true where ac.id is null) then raise exception 'classification_v4_inactive_or_unknown_category'; end if;
    if not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,p_classifier->>'source_anchor') or not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,p_critic->>'source_anchor') then raise exception 'classification_v4_profile_anchor_not_grounded'; end if;
    if exists(select 1 from jsonb_to_recordset(p_classifier->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text) where not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,x.source_anchor)) or exists(select 1 from jsonb_to_recordset(p_critic->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text) where not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,x.source_anchor)) then raise exception 'classification_v4_membership_anchor_not_grounded'; end if;
  end if;

  v_reason:=coalesce(p_classifier->>'reason','');v_anchor:=nullif(p_classifier->>'source_anchor','');
  insert into public.article_profiles_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,category_catalog_fingerprint,classification_input_sha256,classification_status,primary_category,consumer_scene,market_signal,product_type,consumer_need,confidence,reason,source_anchor,classifier_model,critic_model,classifier_version,evidence_json,classification_job_id,updated_at)
  values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.category_catalog_fingerprint,j.classification_input_sha256,v_status_a,v_primary_a,p_classifier->>'consumer_scene',p_classifier->>'market_signal',p_classifier->>'product_type',p_classifier->>'consumer_need',least(v_conf_a,v_conf_b),v_reason,v_anchor,left(p_classifier_model,200),left(p_critic_model,200),j.classifier_version,jsonb_build_object('classifier',p_classifier,'critic',p_critic),j.id,now())
  on conflict(article_id,freeze_receipt_id,classifier_version,classification_input_sha256,category_catalog_fingerprint)
  do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,classification_status=excluded.classification_status,primary_category=excluded.primary_category,consumer_scene=excluded.consumer_scene,market_signal=excluded.market_signal,product_type=excluded.product_type,consumer_need=excluded.consumer_need,confidence=excluded.confidence,reason=excluded.reason,source_anchor=excluded.source_anchor,classifier_model=excluded.classifier_model,critic_model=excluded.critic_model,evidence_json=excluded.evidence_json,classification_job_id=excluded.classification_job_id,updated_at=now()
  returning id into v_profile_id;

  delete from public.article_category_memberships_v4 where profile_id=v_profile_id;
  if v_status_a='categorized' then
    insert into public.article_category_memberships_v4(profile_id,article_id,category_id,score,confidence,source_anchor,reason,evidence_json)
    select v_profile_id,j.article_id,a.category_id,least(coalesce(a.score,0),coalesce(c.score,0)),least(coalesce(a.confidence,0),coalesce(c.confidence,0)),a.source_anchor,coalesce(a.reason,''),jsonb_build_object('classifier',to_jsonb(a),'critic',to_jsonb(c))
    from jsonb_to_recordset(p_classifier->'memberships') a(category_id text,score numeric,confidence numeric,source_anchor text,reason text)
    join jsonb_to_recordset(p_critic->'memberships') c(category_id text,score numeric,confidence numeric,source_anchor text,reason text) using(category_id);
  end if;

  update public.article_classification_jobs_v4 set status='completed',result_json=jsonb_build_object('classifier',p_classifier,'critic',p_critic,'profile_id',v_profile_id),lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','profile_id',v_profile_id,'classification_status',v_status_a);
end $$;

create view public.formal_article_profiles_v4 as
select p.*
from public.article_profiles_v4 p
join public.formal_article_classification_input_v4 i on i.article_id=p.article_id
join public.article_classification_jobs_v4 j on j.id=p.classification_job_id and j.status='completed'
join public.article_classification_pass_runs_v4 ca on ca.job_id=j.id and ca.pass_kind='classifier'
join public.article_classification_pass_runs_v4 cr on cr.job_id=j.id and cr.pass_kind='critic'
where p.classifier_version='article_category_profile_v4_source_grounded_dual'
  and ca.model<>cr.model and ca.provider_response_id<>cr.provider_response_id and ca.prompt_sha256<>cr.prompt_sha256
  and p.classifier_model=ca.model and p.critic_model=cr.model
  and p.article_id=j.article_id
  and p.freeze_receipt_id=i.freeze_receipt_id and p.freeze_receipt_id=j.freeze_receipt_id
  and p.source_region_id=i.source_region_id and p.source_region_id=j.source_region_id
  and p.source_partition_job_id=i.partition_job_id and p.source_partition_job_id=j.source_partition_job_id
  and p.source_region_sha256=i.source_region_sha256 and p.source_region_sha256=j.source_region_sha256
  and p.source_ocr_sha256=i.current_source_raw_ocr_sha256 and p.source_ocr_sha256=j.source_ocr_sha256
  and p.category_catalog_fingerprint=i.category_catalog_fingerprint and p.category_catalog_fingerprint=j.category_catalog_fingerprint
  and p.classification_input_sha256=i.classification_input_sha256 and p.classification_input_sha256=j.classification_input_sha256;

create or replace view public.formal_category_memberships_v4 as
select m.article_id,m.category_id,m.score,m.confidence,'article_category_profile_v4_source_grounded_dual'::text source,array[]::text[] match_terms,m.reason,m.created_at,m.updated_at,
       g.analysis_body_sha256 source_clean_body_sha256,p.source_region_id,p.source_region_sha256,p.source_partition_job_id,p.freeze_receipt_id
from public.article_category_memberships_v4 m
join public.formal_article_profiles_v4 p on p.id=m.profile_id and p.article_id=m.article_id
join public.formal_source_grounded_articles_v4 g on g.article_id=p.article_id
join public.analysis_categories c on c.id=m.category_id and c.is_active=true
where p.classification_status='categorized';

create or replace view public.category_classification_gate_v4 as
with i as (select * from public.formal_article_classification_input_v4),p as (select * from public.formal_article_profiles_v4),profile_checks as (
  select p.article_id,p.classification_status,(select count(*) from public.article_category_memberships_v4 m where m.profile_id=p.id) membership_count,p.primary_category
  from p
),invalid as (
  select count(*)::integer n from profile_checks x
  where (x.classification_status='categorized' and (x.membership_count<1 or x.primary_category is null)) or (x.classification_status='no_matching_category' and (x.membership_count<>0 or x.primary_category is not null))
)
select (select count(*)::integer from i) formal_article_count,(select count(*)::integer from p) profiled_article_count,(select count(*)::integer from p where classification_status='categorized') categorized_article_count,(select count(*)::integer from p where classification_status='no_matching_category') no_matching_category_count,(select n from invalid) invalid_profile_count,(select count(*)::integer from public.article_classification_jobs_v4 where status='needs_review') needs_review_job_count,
       case when (select count(*) from i)>0 and (select count(*) from i)=(select count(*) from p) and (select n from invalid)=0 and (select count(*) from public.article_classification_jobs_v4 where status='needs_review')=0 then 'passed' else 'failed' end category_classification_gate,
       case when (select count(*) from i)=0 then 'source_grounded_articles_required' when (select count(*) from i)<>(select count(*) from p) then 'source_grounded_profiles_missing' when (select n from invalid)>0 then 'profile_membership_consistency_failed' when (select count(*) from public.article_classification_jobs_v4 where status='needs_review')>0 then 'classification_review_required' else 'passed' end gate_reason;

create or replace function public.validate_article_source_grounding_review_v3()
returns trigger language plpgsql set search_path=pg_catalog,public,extensions as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;v_mapper public.source_page_partition_pass_runs_v3%rowtype;v_critic public.source_page_partition_pass_runs_v3%rowtype;v_ground public.article_source_grounding_pass_runs_v3%rowtype;
  v_article_source uuid;v_article_page uuid;v_evidence_page uuid;v_article_text text;v_article_hash text;v_source_text text;v_source_hash text;v_current_freeze uuid;v_region_text text;v_region_hash text;v_term text;v_terms text[];v_total_chars integer:=0;v_unique_region_terms integer:=0;v_other_region_hits integer;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=new.partition_job_id;if not found then raise exception 'grounding_review_partition_job_missing'; end if;
  if j.status not in ('running','needs_review') then raise exception 'grounding_review_partition_job_not_writable'; end if;
  if new.evidence_source_image_id<>j.evidence_source_image_id or new.freeze_receipt_id<>j.freeze_receipt_id then raise exception 'grounding_review_job_binding_mismatch'; end if;
  select * into v_mapper from public.source_page_partition_pass_runs_v3 where job_id=j.id and pass_kind='mapper';select * into v_critic from public.source_page_partition_pass_runs_v3 where job_id=j.id and pass_kind='critic';select * into v_ground from public.article_source_grounding_pass_runs_v3 where job_id=j.id;
  if v_mapper.job_id is null or v_critic.job_id is null or v_ground.job_id is null then raise exception 'grounding_review_all_pass_receipts_required'; end if;
  if v_mapper.model=v_critic.model or v_ground.model in (v_mapper.model,v_critic.model) or new.grounding_model<>v_ground.model then raise exception 'grounding_review_three_distinct_models_required'; end if;
  if v_ground.provider_response_id in (v_mapper.provider_response_id,v_critic.provider_response_id) then raise exception 'grounding_review_distinct_response_receipt_required'; end if;
  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v1 where freeze_gate='passed';if v_current_freeze is null or v_current_freeze<>j.freeze_receipt_id then raise exception 'grounding_review_current_freeze_stale'; end if;
  select f.source_image_id,coalesce(f.headline,'')||' '||coalesce(a.analysis_body_clean,''),a.analysis_body_clean_sha256 into v_article_source,v_article_text,v_article_hash from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id where f.id=new.article_id;
  if v_article_source is null or new.article_clean_body_sha256<>v_article_hash then raise exception 'grounding_review_article_not_current'; end if;
  select page_identity_source_image_id into v_article_page from public.source_page_capture_map_v1 where source_image_id=v_article_source;select page_identity_source_image_id into v_evidence_page from public.source_page_capture_map_v1 where source_image_id=new.evidence_source_image_id;
  if v_article_page is null or v_evidence_page is null or v_article_page<>v_evidence_page or v_article_page<>j.page_identity_source_image_id then raise exception 'grounding_review_capture_not_same_page_identity'; end if;
  select coalesce(ocr_text_raw,''),raw_ocr_sha256 into v_source_text,v_source_hash from public.source_images where id=new.evidence_source_image_id;if v_source_text='' or v_source_hash is null or new.source_ocr_sha256<>v_source_hash then raise exception 'grounding_review_source_hash_mismatch'; end if;
  select coalesce(string_agg(b.block_text,E'\n\n' order by p.block_index),'') into v_region_text from public.source_page_partition_proposals_v3 p join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=new.article_id;
  if v_region_text='' then raise exception 'grounding_review_critic_region_missing'; end if;v_region_hash:=encode(extensions.digest(convert_to(v_region_text,'UTF8'),'sha256'),'hex');if new.region_sha256<>v_region_hash then raise exception 'grounding_review_region_hash_mismatch'; end if;
  if new.grounding_decision='passed' then
    if new.mapper_decision<>'passed' or new.critic_decision<>'passed' then raise exception 'grounding_review_assignment_decisions_not_passed'; end if;
    select coalesce(array_agg(t order by t),'{}'::text[]) into v_terms from (select distinct btrim(x) t from unnest(coalesce(new.shared_terms,'{}'::text[])) x where btrim(x)<>'') q;if coalesce(array_length(v_terms,1),0)<3 then raise exception 'grounding_review_requires_three_distinct_shared_terms'; end if;
    foreach v_term in array v_terms loop
      if char_length(v_term)<3 or position(v_term in v_article_text)=0 or position(v_term in v_source_text)=0 or position(v_term in v_region_text)=0 then raise exception 'grounding_review_term_not_exactly_grounded'; end if;v_total_chars:=v_total_chars+char_length(v_term);
      select count(*) into v_other_region_hits from (select p.article_id,string_agg(b.block_text,E'\n\n' order by p.block_index) other_region from public.source_page_partition_proposals_v3 p join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id is distinct from new.article_id group by p.article_id) q where position(v_term in q.other_region)>0;if v_other_region_hits=0 then v_unique_region_terms:=v_unique_region_terms+1; end if;
    end loop;
    if v_total_chars<12 or v_unique_region_terms<2 then raise exception 'grounding_review_shared_terms_not_sufficient'; end if;new.shared_terms:=v_terms;
  else new.shared_terms:=coalesce(new.shared_terms,'{}'::text[]); end if;return new;
end $$;

revoke insert,update,delete,truncate,references,trigger on table public.article_embeddings_v4 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_embedding_jobs_v4 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_profiles_v4 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_category_memberships_v4 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_classification_jobs_v4 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_classification_pass_runs_v4 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.source_page_partition_jobs_v3 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.source_page_partition_proposals_v3 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.source_page_partition_pass_runs_v3 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_source_grounding_reviews_v3 from service_role;
revoke insert,update,delete,truncate,references,trigger on table public.article_source_grounding_pass_runs_v3 from service_role;
grant select on table public.article_embeddings_v4,public.article_embedding_jobs_v4,public.article_profiles_v4,public.article_category_memberships_v4,public.article_classification_jobs_v4,public.article_classification_pass_runs_v4,public.source_page_partition_jobs_v3,public.source_page_partition_proposals_v3,public.source_page_partition_pass_runs_v3,public.article_source_grounding_reviews_v3,public.article_source_grounding_pass_runs_v3 to service_role;
revoke all on table public.formal_article_profiles_v4 from anon,authenticated;grant select on table public.formal_article_profiles_v4 to service_role;