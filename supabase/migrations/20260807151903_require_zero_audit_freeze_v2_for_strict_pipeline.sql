create or replace view public.formal_source_grounded_articles_v4 as
select v.article_id,v.headline,v.article_date,v.article_type,v.source_image_id,
       i.page_identity_source_image_id,i.evidence_source_image_id,
       v.analysis_body,v.analysis_body_sha256,v.analysis_body_chars,
       r.id as source_region_id,r.partition_job_id,r.region_version,r.page_index,
       r.x_min,r.y_min,r.x_max,r.y_max,r.mapping_method,r.mapping_confidence,r.headline_anchor,r.headline_similarity,
       r.source_region_text,r.source_region_sha256,r.source_image_raw_ocr_sha256,es.raw_ocr_sha256 as current_source_raw_ocr_sha256,
       r.source_clean_body_sha256,r.block_partition_version,r.assigned_block_count,r.partition_fingerprint,r.quality_status,r.quality_reason,i.integrity_gate
from public.formal_article_analysis_text_v2 v
join public.article_source_region_integrity_v4 i on i.article_id=v.article_id and i.integrity_gate='passed'
join public.article_source_regions r on r.id=i.source_region_id and r.partition_job_id=i.partition_job_id
join public.source_images es on es.id=i.evidence_source_image_id
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed'
where r.region_version='source_region_v3_page_identity_blockset' and r.quality_status='passed'
  and r.source_clean_body_sha256=v.analysis_body_sha256 and r.source_image_raw_ocr_sha256=es.raw_ocr_sha256
  and coalesce(r.source_region_text,'')<>'' and coalesce(r.source_region_sha256,'') ~ '^[0-9a-f]{64}$';

create or replace view public.formal_article_embedding_input_v4 as
with block_text as (
  select b.article_id,string_agg(regexp_replace(btrim(b.block_text),'\s+',' ','g'),E'\n---\n' order by b.x_min,b.y_min,b.block_index) embedding_input_text
  from public.formal_source_grounded_article_blocks_v4 b group by b.article_id
)
select g.article_id,g.source_region_id,g.partition_job_id,g.page_identity_source_image_id,g.evidence_source_image_id,g.source_region_sha256,g.current_source_raw_ocr_sha256,g.analysis_body_sha256,
       fg.freeze_receipt_id,bt.embedding_input_text,encode(extensions.digest(convert_to(bt.embedding_input_text,'UTF8'),'sha256'),'hex') embedding_input_sha256
from public.formal_source_grounded_articles_v4 g
join block_text bt on bt.article_id=g.article_id
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed'
where coalesce(bt.embedding_input_text,'')<>'';

create or replace view public.formal_article_classification_input_v4 as
with blocks as (
  select b.article_id,jsonb_agg(jsonb_build_object('block_index',b.block_index,'text',b.block_text,'x_min',b.x_min,'y_min',b.y_min,'x_max',b.x_max,'y_max',b.y_max,'ocr_confidence',b.ocr_confidence) order by b.x_min,b.y_min,b.block_index) blocks_json
  from public.formal_source_grounded_article_blocks_v4 b group by b.article_id
)
select g.article_id,g.source_region_id,g.partition_job_id,g.source_region_sha256,g.current_source_raw_ocr_sha256,
       fg.freeze_receipt_id,public.analysis_category_catalog_fingerprint_v4() category_catalog_fingerprint,b.blocks_json,
       encode(extensions.digest(convert_to(jsonb_build_object('article_id',g.article_id,'source_region_sha256',g.source_region_sha256,'blocks',b.blocks_json)::text,'UTF8'),'sha256'),'hex') classification_input_sha256
from public.formal_source_grounded_articles_v4 g join blocks b on b.article_id=g.article_id
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed';

create or replace function public.formal_corpus_scope_proof_v4(p_scope_type text default 'all',p_scope_query text default '')
returns table(article_count bigint,source_truth_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with gated as (select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed'), scoped as (
  select distinct f.id article_id,f.source_image_id,m.page_identity_source_image_id,coalesce(f.headline,'') headline,a.article_date_normalized,a.analysis_body_clean_sha256,s.raw_ocr_sha256
  from gated,public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id join public.source_images s on s.id=f.source_image_id join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
  where p_scope_type='all' or (p_scope_type='category' and coalesce(p_scope_query,'')<>'' and exists(select 1 from public.formal_category_memberships_v4 cm where cm.article_id=f.id and cm.category_id=p_scope_query))
), c as (
  select count(*)::bigint n,coalesce(string_agg(encode(extensions.digest(convert_to(jsonb_build_array(article_id::text,source_image_id::text,page_identity_source_image_id::text,headline,coalesce(article_date_normalized::text,''),coalesce(analysis_body_clean_sha256,''),coalesce(raw_ocr_sha256,''))::text,'UTF8'),'sha256'),'hex'),'|' order by article_id::text),'') payload from scoped
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex') from c where p_scope_type in ('all','category');
$$;

create or replace function public.formal_source_grounded_scope_proof_v4(p_scope_type text default 'all',p_scope_query text default '')
returns table(article_count bigint,source_grounded_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with gated as (select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed'), scoped as (
  select distinct g.article_id,g.source_image_id,g.page_identity_source_image_id,g.evidence_source_image_id,g.source_region_id,g.partition_job_id,g.analysis_body_sha256,g.source_region_sha256,g.current_source_raw_ocr_sha256
  from gated,public.formal_source_grounded_articles_v4 g
  where p_scope_type='all' or (p_scope_type='category' and coalesce(p_scope_query,'')<>'' and exists(select 1 from public.formal_category_memberships_v4 cm where cm.article_id=g.article_id and cm.category_id=p_scope_query))
), c as (
  select count(*)::bigint n,coalesce(string_agg(encode(extensions.digest(convert_to(jsonb_build_array(article_id::text,source_image_id::text,page_identity_source_image_id::text,evidence_source_image_id::text,source_region_id::text,partition_job_id::text,analysis_body_sha256,source_region_sha256,current_source_raw_ocr_sha256)::text,'UTF8'),'sha256'),'hex'),'|' order by article_id::text),'') payload from scoped
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex') from c where p_scope_type in ('all','category');
$$;

create function public.enqueue_source_page_partition_jobs_v4()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if (select freeze_gate_v2 from public.formal_corpus_freeze_gate_v2)<>'passed' then raise exception 'partition_v4_freeze_v2_not_passed'; end if;
  return public.enqueue_source_page_partition_jobs_v3();
end $$;

create function public.claim_source_page_partition_job_v4(p_lease_seconds integer default 420)
returns setof public.source_page_partition_jobs_v3 language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if (select freeze_gate_v2 from public.formal_corpus_freeze_gate_v2)<>'passed' then raise exception 'partition_v4_freeze_v2_not_passed'; end if;
  return query select * from public.claim_source_page_partition_job_v3(p_lease_seconds);
end $$;

create function public.get_source_page_partition_job_input_v4(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.source_page_partition_jobs_v3%rowtype;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id;
  if not found then raise exception 'partition_v4_job_missing'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'partition_v4_freeze_v2_stale'; end if;
  return public.get_source_page_partition_job_input_v3(p_job_id,p_lease_token);
end $$;

create function public.renew_source_page_partition_job_lease_v4(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 420)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.source_page_partition_jobs_v3%rowtype;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id;
  if not found then raise exception 'partition_v4_job_missing'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'partition_v4_freeze_v2_stale'; end if;
  return public.renew_source_page_partition_job_lease_v3(p_job_id,p_lease_token,p_lease_seconds);
end $$;

create or replace function public.replace_source_page_partition_proposals_v4(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_result jsonb;j public.source_page_partition_jobs_v3%rowtype;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id;if not found then raise exception 'partition_v4_job_missing'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'partition_v4_freeze_v2_stale'; end if;
  if p_pass_kind not in ('mapper','critic') or coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'partition_v4_pass_receipt_invalid'; end if;
  v_result:=public.replace_source_page_partition_proposals_v3(p_job_id,p_lease_token,p_pass_kind,p_rows);
  insert into public.source_page_partition_pass_runs_v3(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values(p_job_id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  return v_result||jsonb_build_object('model',p_model,'provider_response_id',p_provider_response_id);
end $$;

create or replace function public.finalize_source_page_partition_job_v4(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_mapper public.source_page_partition_pass_runs_v3%rowtype;v_critic public.source_page_partition_pass_runs_v3%rowtype;j public.source_page_partition_jobs_v3%rowtype;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id;if not found then raise exception 'partition_v4_job_missing'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'partition_v4_freeze_v2_stale'; end if;
  select * into v_mapper from public.source_page_partition_pass_runs_v3 where job_id=p_job_id and pass_kind='mapper';select * into v_critic from public.source_page_partition_pass_runs_v3 where job_id=p_job_id and pass_kind='critic';
  if v_mapper.job_id is null or v_critic.job_id is null then raise exception 'partition_v4_pass_receipts_missing'; end if;
  if v_mapper.model=v_critic.model or v_mapper.provider_response_id=v_critic.provider_response_id or v_mapper.prompt_sha256=v_critic.prompt_sha256 then raise exception 'partition_v4_independent_passes_required'; end if;
  return public.finalize_source_page_partition_job_v3(p_job_id,p_lease_token,v_mapper.model,v_critic.model);
end $$;

create or replace function public.replace_article_source_grounding_reviews_v4(p_job_id uuid,p_lease_token uuid,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_mapper public.source_page_partition_pass_runs_v3%rowtype;v_critic public.source_page_partition_pass_runs_v3%rowtype;v_result jsonb;j public.source_page_partition_jobs_v3%rowtype;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id;if not found then raise exception 'grounding_v4_job_missing'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'grounding_v4_freeze_v2_stale'; end if;
  select * into v_mapper from public.source_page_partition_pass_runs_v3 where job_id=p_job_id and pass_kind='mapper';select * into v_critic from public.source_page_partition_pass_runs_v3 where job_id=p_job_id and pass_kind='critic';
  if v_mapper.job_id is null or v_critic.job_id is null then raise exception 'grounding_v4_partition_pass_receipts_required'; end if;
  if coalesce(btrim(p_model),'')='' or p_model in (v_mapper.model,v_critic.model) or coalesce(btrim(p_provider_response_id),'')='' or p_provider_response_id in (v_mapper.provider_response_id,v_critic.provider_response_id) or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or p_prompt_sha256 in (v_mapper.prompt_sha256,v_critic.prompt_sha256) then raise exception 'grounding_v4_receipt_invalid'; end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,grounding_decision text,shared_terms text[],reason text,grounding_model text) where coalesce(x.grounding_model,'')<>p_model) then raise exception 'grounding_v4_row_model_mismatch'; end if;
  insert into public.article_source_grounding_pass_runs_v3(job_id,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values(p_job_id,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now())
  on conflict(job_id) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  v_result:=public.replace_article_source_grounding_reviews_v3(p_job_id,p_lease_token,p_rows);
  return v_result||jsonb_build_object('grounding_model',p_model,'grounding_response_id',p_provider_response_id);
end $$;

revoke execute on function public.enqueue_source_page_partition_jobs_v3() from service_role;
revoke execute on function public.claim_source_page_partition_job_v3(integer) from service_role;
revoke execute on function public.get_source_page_partition_job_input_v3(uuid,uuid) from service_role;
revoke execute on function public.renew_source_page_partition_job_lease_v3(uuid,uuid,integer) from service_role;
revoke execute on function public.enqueue_source_page_partition_jobs_v4() from public,anon,authenticated;
revoke execute on function public.claim_source_page_partition_job_v4(integer) from public,anon,authenticated;
revoke execute on function public.get_source_page_partition_job_input_v4(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.renew_source_page_partition_job_lease_v4(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.enqueue_source_page_partition_jobs_v4() to service_role;
grant execute on function public.claim_source_page_partition_job_v4(integer) to service_role;
grant execute on function public.get_source_page_partition_job_input_v4(uuid,uuid) to service_role;
grant execute on function public.renew_source_page_partition_job_lease_v4(uuid,uuid,integer) to service_role;