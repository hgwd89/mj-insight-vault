begin;

alter table public.article_embedding_jobs_v4
  add column if not exists provider_request_id text,
  add column if not exists response_sha256 text;
alter table public.article_embeddings_v4
  add column if not exists provider_request_id text,
  add column if not exists response_sha256 text;

create or replace view public.formal_source_grounded_articles_v5
with (security_invoker=true)
as
select g.*,
       v.verification_version,v.region_quality_status,v.verification_mode,
       v.canonical_text as verified_canonical_text,v.canonical_text_sha256 as verified_canonical_text_sha256,
       v.numeric_verification_status,v.proper_noun_verification_status,
       v.independent_provider,v.independent_model,v.independent_response_id,v.independent_prompt_sha256,v.independent_response_sha256,
       v.verified_at as ocr_verified_at,
       ip.ingest_mode,ip.original_available,ip.quality_status as ingest_quality_status
from public.formal_source_grounded_articles_v6 g
join public.article_ocr_verifications_v1 v
  on v.article_id=g.article_id and v.source_region_id=g.source_region_id and v.partition_job_id=g.partition_job_id
 and v.source_region_sha256=g.source_region_sha256 and v.source_ocr_sha256=g.current_source_raw_ocr_sha256
join public.source_image_ingest_provenance_v2 ip on ip.source_image_id=g.evidence_source_image_id
where v.verification_version='article_ocr_verification_v5_crop_ocr_plus_independent_vision'
  and v.verification_mode='crop_ocr_consensus'
  and v.quality_status='passed'
  and coalesce(v.canonical_text,'')<>''
  and v.numeric_verification_status in ('passed','not_applicable')
  and v.proper_noun_verification_status in ('passed','not_applicable')
  and v.canonical_text_sha256=encode(extensions.digest(convert_to(v.canonical_text,'UTF8'),'sha256'),'hex')
  and ip.quality_status not in ('needs_review','failed')
  and (ip.ingest_mode<>'legacy_reencoded_derivative' or v.verification_mode in ('crop_ocr_consensus','manual_verified'));

create or replace function public.enqueue_article_embedding_jobs_v5()
returns integer
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare v_count integer;
begin
  if not exists(select 1 from public.ocr_verification_gate_v2 where ocr_verification_gate='passed') then raise exception 'embedding_v5_ocr_verification_not_passed'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then raise exception 'embedding_v5_freeze_not_passed'; end if;
  with ins as (
    insert into public.article_embedding_jobs_v4(
      article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,
      embedding_input_text,embedding_input_sha256,embedding_version,status,attempt_count,created_at,updated_at
    )
    select i.article_id,i.source_region_id,i.partition_job_id,i.freeze_receipt_id,i.source_region_sha256,i.current_source_raw_ocr_sha256,
           i.embedding_input_text,i.embedding_input_sha256,'article_semantic_verified_ocr_v5','queued',0,now(),now()
    from public.formal_article_embedding_input_v5 i
    on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256) do nothing
    returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end
$function$;

create or replace function public.claim_article_embedding_job_v5(p_lease_seconds integer default 240)
returns setof public.article_embedding_jobs_v4
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_token uuid:=gen_random_uuid();
begin
  if not exists(select 1 from public.ocr_verification_gate_v2 where ocr_verification_gate='passed') then raise exception 'embedding_v5_ocr_verification_not_passed'; end if;
  update public.article_embedding_jobs_v4 set status='failed',last_error_class='lease_expired',error_message='embedding worker lease expired too many times',finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
  where embedding_version='article_semantic_verified_ocr_v5' and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and attempt_count>=4;
  select id into v_id from public.article_embedding_jobs_v4
  where embedding_version='article_semantic_verified_ocr_v5'
    and (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now()))
    and attempt_count<4 and (next_retry_at is null or next_retry_at<=now())
  order by created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.article_embedding_jobs_v4 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,p_lease_seconds))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),last_error_class=null,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.article_embedding_jobs_v4 where id=v_id;
end
$function$;

create or replace function public.renew_article_embedding_job_lease_v5(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 240)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.article_embedding_jobs_v4%rowtype;
begin
 select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
 if not found or j.embedding_version<>'article_semantic_verified_ocr_v5' or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'embedding_v5_lease_invalid'; end if;
 update public.article_embedding_jobs_v4 set lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,p_lease_seconds))),updated_at=now() where id=j.id;
 return jsonb_build_object('status','running','job_id',j.id);
end
$function$;

create or replace function public.complete_article_embedding_job_v5(p_job_id uuid,p_lease_token uuid,p_embedding_vector_text text,p_embedding_model text,p_provider_request_id text,p_response_sha256 text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.article_embedding_jobs_v4%rowtype;i public.formal_article_embedding_input_v5%rowtype;v extensions.vector(1536);
begin
 select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
 if not found or j.embedding_version<>'article_semantic_verified_ocr_v5' then raise exception 'embedding_v5_job_missing'; end if;
 if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'embedding_v5_lease_invalid'; end if;
 select * into i from public.formal_article_embedding_input_v5 where article_id=j.article_id;
 if not found then raise exception 'embedding_v5_input_not_current'; end if;
 if i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.embedding_input_sha256<>j.embedding_input_sha256 or i.embedding_input_text<>j.embedding_input_text then raise exception 'embedding_v5_input_stale'; end if;
 if p_embedding_model<>'text-embedding-3-small' then raise exception 'embedding_v5_model_must_be_text_embedding_3_small'; end if;
 if coalesce(btrim(p_provider_request_id),'')='' then raise exception 'embedding_v5_provider_request_id_required'; end if;
 if coalesce(p_response_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'embedding_v5_response_sha_invalid'; end if;
 begin v:=p_embedding_vector_text::extensions.vector(1536); exception when others then raise exception 'embedding_v5_vector_invalid'; end;
 if v is null then raise exception 'embedding_v5_vector_missing'; end if;
 insert into public.article_embeddings_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,embedding_input_text,embedding_input_sha256,embedding_vector,embedding_model,embedding_version,quality_status,embedding_job_id,provider_request_id,response_sha256,updated_at)
 values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.embedding_input_text,j.embedding_input_sha256,v,p_embedding_model,j.embedding_version,'passed',j.id,p_provider_request_id,p_response_sha256,now())
 on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256)
 do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,embedding_input_text=excluded.embedding_input_text,embedding_vector=excluded.embedding_vector,embedding_model=excluded.embedding_model,quality_status='passed',embedding_job_id=excluded.embedding_job_id,provider_request_id=excluded.provider_request_id,response_sha256=excluded.response_sha256,updated_at=now();
 update public.article_embedding_jobs_v4 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,provider_request_id=p_provider_request_id,response_sha256=p_response_sha256,finished_at=now(),updated_at=now() where id=j.id;
 return jsonb_build_object('status','completed','job_id',j.id,'article_id',j.article_id);
end
$function$;

create or replace function public.fail_article_embedding_job_v5(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'runtime')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.article_embedding_jobs_v4%rowtype;v_next text;v_structural boolean;v_delay integer;
begin
 select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
 if not found or j.embedding_version<>'article_semantic_verified_ocr_v5' or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'embedding_v5_fail_lease_invalid'; end if;
 v_structural:=coalesce(p_error_message,'')~*'(input_stale|input_not_current|vector_invalid|model_must|provider_request_id|required|response_sha)';
 v_next:=case when v_structural or not p_retryable or j.attempt_count>=4 then 'failed' else 'queued' end;
 v_delay:=least(3600,greatest(15,15*power(2,greatest(j.attempt_count-1,0))::integer));
 update public.article_embedding_jobs_v4 set status=v_next,lease_token=null,lease_expires_at=null,next_retry_at=case when v_next='queued' then now()+make_interval(secs=>v_delay) else null end,last_error_class=left(coalesce(p_error_class,'runtime'),100),error_message=left(coalesce(p_error_message,''),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;
 return jsonb_build_object('status',v_next,'attempt_count',j.attempt_count,'retry_scheduled',v_next='queued');
end
$function$;

create or replace view public.formal_article_embeddings_v5
with (security_invoker=true)
as
select e.*
from public.article_embeddings_v4 e
join public.formal_article_embedding_input_v5 i on i.article_id=e.article_id
join public.article_embedding_jobs_v4 j on j.id=e.embedding_job_id and j.status='completed' and j.embedding_version='article_semantic_verified_ocr_v5'
where e.embedding_version='article_semantic_verified_ocr_v5' and e.quality_status='passed'
  and e.article_id=j.article_id and e.freeze_receipt_id=i.freeze_receipt_id and e.freeze_receipt_id=j.freeze_receipt_id
  and e.source_region_id=i.source_region_id and e.source_region_id=j.source_region_id
  and e.source_partition_job_id=i.partition_job_id and e.source_partition_job_id=j.source_partition_job_id
  and e.source_region_sha256=i.source_region_sha256 and e.source_region_sha256=j.source_region_sha256
  and e.source_ocr_sha256=i.current_source_raw_ocr_sha256 and e.source_ocr_sha256=j.source_ocr_sha256
  and e.embedding_input_sha256=i.embedding_input_sha256 and e.embedding_input_sha256=j.embedding_input_sha256
  and e.embedding_input_text=i.embedding_input_text and e.embedding_input_text=j.embedding_input_text
  and e.embedding_model='text-embedding-3-small'
  and coalesce(e.provider_request_id,'')<>'' and e.response_sha256~'^[0-9a-f]{64}$';

create or replace view public.article_embedding_quality_gate_v5
with (security_invoker=true)
as
with i as (select count(*)::integer formal_article_count from public.formal_article_embedding_input_v5),
e as (select count(*)::integer strict_embedding_count from public.formal_article_embeddings_v5),
j as (select count(*)::integer total_jobs,count(*) filter(where status='queued')::integer queued_jobs,count(*) filter(where status='running')::integer running_jobs,count(*) filter(where status='failed')::integer failed_jobs,count(*) filter(where status='completed')::integer completed_jobs from public.article_embedding_jobs_v4 where embedding_version='article_semantic_verified_ocr_v5')
select i.formal_article_count,e.strict_embedding_count,j.*,
 case when i.formal_article_count>0 and e.strict_embedding_count=i.formal_article_count and j.failed_jobs=0 then 'passed' else 'failed' end embedding_gate,
 case when i.formal_article_count=0 then 'verified_ocr_articles_required' when j.failed_jobs>0 then 'verified_embedding_jobs_failed' when e.strict_embedding_count<>i.formal_article_count then 'verified_embedding_rebuild_required' else 'passed' end gate_reason
from i cross join e cross join j;

revoke all on public.formal_article_embeddings_v5,public.article_embedding_quality_gate_v5 from public,anon,authenticated;
grant select on public.formal_article_embeddings_v5,public.article_embedding_quality_gate_v5 to service_role;

revoke all on function public.enqueue_article_embedding_jobs_v5() from public,anon,authenticated;
revoke all on function public.claim_article_embedding_job_v5(integer) from public,anon,authenticated;
revoke all on function public.renew_article_embedding_job_lease_v5(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.complete_article_embedding_job_v5(uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.fail_article_embedding_job_v5(uuid,uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.enqueue_article_embedding_jobs_v5() to service_role;
grant execute on function public.claim_article_embedding_job_v5(integer) to service_role;
grant execute on function public.renew_article_embedding_job_lease_v5(uuid,uuid,integer) to service_role;
grant execute on function public.complete_article_embedding_job_v5(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.fail_article_embedding_job_v5(uuid,uuid,text,boolean,text) to service_role;

commit;