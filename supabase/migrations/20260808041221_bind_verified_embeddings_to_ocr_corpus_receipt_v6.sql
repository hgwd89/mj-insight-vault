begin;

create or replace function public.enqueue_article_embedding_jobs_v5()
returns integer language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_receipt public.verified_ocr_corpus_receipts_v5%rowtype;v_count integer;
begin
 if not exists(select 1 from public.ocr_verification_gate_v2 where ocr_verification_gate='passed') then raise exception 'embedding_v6_ocr_verification_not_passed'; end if;
 perform public.create_verified_ocr_corpus_receipt_v5();
 select * into v_receipt from public.current_verified_ocr_corpus_receipt_v5;
 if not found then raise exception 'embedding_v6_ocr_receipt_missing'; end if;
 with ins as (
   insert into public.article_embedding_jobs_v4(
     article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,
     embedding_input_text,embedding_input_sha256,embedding_version,ocr_receipt_id,ocr_verification_set_fingerprint,status,attempt_count,created_at,updated_at
   )
   select i.article_id,i.source_region_id,i.partition_job_id,i.freeze_receipt_id,i.source_region_sha256,i.current_source_raw_ocr_sha256,
          i.embedding_input_text,i.embedding_input_sha256,'article_semantic_verified_ocr_v5',v_receipt.id,v_receipt.verification_set_fingerprint,'queued',0,now(),now()
   from public.formal_article_embedding_input_v5 i
   on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256) do update set
      ocr_receipt_id=excluded.ocr_receipt_id,ocr_verification_set_fingerprint=excluded.ocr_verification_set_fingerprint,
      status=case when article_embedding_jobs_v4.status='completed' and article_embedding_jobs_v4.ocr_receipt_id=excluded.ocr_receipt_id then article_embedding_jobs_v4.status else 'queued' end,
      attempt_count=case when article_embedding_jobs_v4.ocr_receipt_id=excluded.ocr_receipt_id then article_embedding_jobs_v4.attempt_count else 0 end,
      next_retry_at=null,last_error_class=null,error_message=null,lease_token=null,lease_expires_at=null,finished_at=null,updated_at=now()
   returning 1
 ) select count(*)::integer into v_count from ins;
 return v_count;
end
$function$;

create or replace function public.claim_article_embedding_job_v5(p_lease_seconds integer default 240)
returns setof public.article_embedding_jobs_v4 language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_token uuid:=gen_random_uuid();v_receipt uuid;
begin
 select id into v_receipt from public.current_verified_ocr_corpus_receipt_v5;
 if v_receipt is null then raise exception 'embedding_v6_ocr_receipt_missing'; end if;
 update public.article_embedding_jobs_v4 set status='failed',last_error_class='lease_expired',error_message='embedding worker lease expired too many times',finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
 where embedding_version='article_semantic_verified_ocr_v5' and ocr_receipt_id=v_receipt and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and attempt_count>=4;
 select id into v_id from public.article_embedding_jobs_v4
 where embedding_version='article_semantic_verified_ocr_v5' and ocr_receipt_id=v_receipt
   and (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now()))
   and attempt_count<4 and (next_retry_at is null or next_retry_at<=now())
 order by created_at for update skip locked limit 1;
 if v_id is null then return; end if;
 update public.article_embedding_jobs_v4 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,p_lease_seconds))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),last_error_class=null,error_message=null,updated_at=now() where id=v_id;
 return query select * from public.article_embedding_jobs_v4 where id=v_id;
end
$function$;

create or replace function public.complete_article_embedding_job_v5(p_job_id uuid,p_lease_token uuid,p_embedding_vector_text text,p_embedding_model text,p_provider_request_id text,p_response_sha256 text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.article_embedding_jobs_v4%rowtype;i public.formal_article_embedding_input_v5%rowtype;r public.verified_ocr_corpus_receipts_v5%rowtype;v extensions.vector(1536);
begin
 select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
 if not found or j.embedding_version<>'article_semantic_verified_ocr_v5' then raise exception 'embedding_v6_job_missing'; end if;
 if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'embedding_v6_lease_invalid'; end if;
 select * into r from public.current_verified_ocr_corpus_receipt_v5 where id=j.ocr_receipt_id;
 if not found or r.verification_set_fingerprint<>j.ocr_verification_set_fingerprint then raise exception 'embedding_v6_ocr_receipt_stale'; end if;
 select * into i from public.formal_article_embedding_input_v5 where article_id=j.article_id;
 if not found then raise exception 'embedding_v6_input_not_current'; end if;
 if i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.embedding_input_sha256<>j.embedding_input_sha256 or i.embedding_input_text<>j.embedding_input_text then raise exception 'embedding_v6_input_stale'; end if;
 if p_embedding_model<>'text-embedding-3-small' then raise exception 'embedding_v6_model_must_be_text_embedding_3_small'; end if;
 if coalesce(btrim(p_provider_request_id),'')='' then raise exception 'embedding_v6_provider_request_id_required'; end if;
 if coalesce(p_response_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'embedding_v6_response_sha_invalid'; end if;
 begin v:=p_embedding_vector_text::extensions.vector(1536); exception when others then raise exception 'embedding_v6_vector_invalid'; end;
 insert into public.article_embeddings_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,embedding_input_text,embedding_input_sha256,embedding_vector,embedding_model,embedding_version,quality_status,embedding_job_id,provider_request_id,response_sha256,ocr_receipt_id,ocr_verification_set_fingerprint,updated_at)
 values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.embedding_input_text,j.embedding_input_sha256,v,p_embedding_model,j.embedding_version,'passed',j.id,p_provider_request_id,p_response_sha256,j.ocr_receipt_id,j.ocr_verification_set_fingerprint,now())
 on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256) do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,embedding_input_text=excluded.embedding_input_text,embedding_vector=excluded.embedding_vector,embedding_model=excluded.embedding_model,quality_status='passed',embedding_job_id=excluded.embedding_job_id,provider_request_id=excluded.provider_request_id,response_sha256=excluded.response_sha256,ocr_receipt_id=excluded.ocr_receipt_id,ocr_verification_set_fingerprint=excluded.ocr_verification_set_fingerprint,updated_at=now();
 update public.article_embedding_jobs_v4 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,provider_request_id=p_provider_request_id,response_sha256=p_response_sha256,finished_at=now(),updated_at=now() where id=j.id;
 return jsonb_build_object('status','completed','job_id',j.id,'article_id',j.article_id,'ocr_receipt_id',j.ocr_receipt_id);
end
$function$;

create or replace view public.formal_article_embeddings_v5
with (security_invoker=true)
as
select e.*
from public.article_embeddings_v4 e
join public.article_embedding_jobs_v4 j on j.id=e.embedding_job_id and j.status='completed' and j.embedding_version='article_semantic_verified_ocr_v5'
join public.current_verified_ocr_corpus_receipt_v5 r on r.id=e.ocr_receipt_id and r.id=j.ocr_receipt_id and r.verification_set_fingerprint=e.ocr_verification_set_fingerprint and r.verification_set_fingerprint=j.ocr_verification_set_fingerprint
where e.embedding_version='article_semantic_verified_ocr_v5' and e.quality_status='passed'
  and e.article_id=j.article_id and e.freeze_receipt_id=j.freeze_receipt_id and e.source_region_id=j.source_region_id and e.source_partition_job_id=j.source_partition_job_id
  and e.source_region_sha256=j.source_region_sha256 and e.source_ocr_sha256=j.source_ocr_sha256 and e.embedding_input_sha256=j.embedding_input_sha256 and e.embedding_input_text=j.embedding_input_text
  and e.embedding_model='text-embedding-3-small' and coalesce(e.provider_request_id,'')<>'' and e.response_sha256~'^[0-9a-f]{64}$';

create or replace view public.article_embedding_quality_gate_v5
with (security_invoker=true)
as
with r as (select * from public.current_verified_ocr_corpus_receipt_v5),e as (select count(*)::integer strict_embedding_count from public.formal_article_embeddings_v5),j as (
 select count(*)::integer total_jobs,count(*) filter(where status='queued')::integer queued_jobs,count(*) filter(where status='running')::integer running_jobs,count(*) filter(where status='failed')::integer failed_jobs,count(*) filter(where status='completed')::integer completed_jobs
 from public.article_embedding_jobs_v4 where embedding_version='article_semantic_verified_ocr_v5' and ocr_receipt_id=(select id from r)
)
select coalesce(r.article_count,0)::integer formal_article_count,e.strict_embedding_count,j.*,
 case when r.id is not null and e.strict_embedding_count=r.article_count and j.failed_jobs=0 then 'passed' else 'failed' end embedding_gate,
 case when r.id is null then 'verified_ocr_receipt_required' when j.failed_jobs>0 then 'verified_embedding_jobs_failed' when e.strict_embedding_count<>r.article_count then 'verified_embedding_rebuild_required' else 'passed' end gate_reason
from e cross join j left join r on true;

commit;