begin;

create or replace function public.enqueue_article_classification_jobs_v6()
returns integer
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare v_count integer;
begin
  if (select duplicate_gate from public.source_grounded_duplicate_gate_v6)<>'passed' then raise exception 'classification_v6_duplicate_gate_required'; end if;
  with ins as (
    insert into public.article_classification_jobs_v4(
      article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,
      category_catalog_fingerprint,classification_input_sha256,blocks_json,classifier_version,
      ocr_receipt_id,ocr_verification_set_fingerprint,duplicate_audit_run_id,status,attempt_count,result_json
    )
    select i.article_id,i.source_region_id,i.partition_job_id,i.freeze_receipt_id,i.source_region_sha256,i.current_source_raw_ocr_sha256,
           i.category_catalog_fingerprint,i.classification_input_sha256,i.blocks_json,'article_category_profile_v6_verified_ocr_dual',
           i.ocr_receipt_id,i.ocr_verification_set_fingerprint,i.duplicate_audit_run_id,'queued',0,'{}'::jsonb
    from public.formal_article_classification_input_v6 i
    on conflict(article_id,freeze_receipt_id,classifier_version,classification_input_sha256,category_catalog_fingerprint) do nothing
    returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end
$function$;

create or replace function public.claim_article_classification_job_v6(p_lease_seconds integer default 240)
returns setof public.article_classification_jobs_v4
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_status text;v_token uuid:=gen_random_uuid();v_pass text;
begin
  if (select duplicate_gate from public.source_grounded_duplicate_gate_v6)<>'passed' then raise exception 'classification_v6_duplicate_gate_required'; end if;
  update public.article_classification_jobs_v4
     set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='classification lease expired too many times',finished_at=now(),updated_at=now()
   where classifier_version='article_category_profile_v6_verified_ocr_dual'
     and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and attempt_count>=3;
  select j.id,j.status,
         case
           when not exists(select 1 from public.article_classification_stage_v6 s where s.job_id=j.id and s.pass_kind='classifier') then 'classifier'
           when not exists(select 1 from public.article_classification_stage_v6 s where s.job_id=j.id and s.pass_kind='critic') then 'critic'
           else null
         end
    into v_id,v_status,v_pass
  from public.article_classification_jobs_v4 j
  where j.classifier_version='article_category_profile_v6_verified_ocr_dual'
    and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
    and j.attempt_count<4
    and (
      not exists(select 1 from public.article_classification_stage_v6 s where s.job_id=j.id and s.pass_kind='classifier')
      or not exists(select 1 from public.article_classification_stage_v6 s where s.job_id=j.id and s.pass_kind='critic')
    )
  order by j.created_at
  for update skip locked
  limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.article_classification_jobs_v4
     set status='running',active_pass_kind=v_pass,lease_token=v_token,
         lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),
         attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,
         error_message=null,updated_at=now()
   where id=v_id;
  return query select * from public.article_classification_jobs_v4 where id=v_id;
end
$function$;

create or replace function public.get_article_classification_input_v6(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare j public.article_classification_jobs_v4%rowtype;i public.formal_article_classification_input_v6%rowtype;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id;
  if not found or j.classifier_version<>'article_category_profile_v6_verified_ocr_dual' or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'classification_v6_lease_invalid'; end if;
  select * into i from public.formal_article_classification_input_v6 where article_id=j.article_id;
  if not found
     or i.freeze_receipt_id<>j.freeze_receipt_id
     or i.source_region_id<>j.source_region_id
     or i.partition_job_id<>j.source_partition_job_id
     or i.source_region_sha256<>j.source_region_sha256
     or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256
     or i.category_catalog_fingerprint<>j.category_catalog_fingerprint
     or i.classification_input_sha256<>j.classification_input_sha256
     or i.ocr_receipt_id is distinct from j.ocr_receipt_id
     or i.ocr_verification_set_fingerprint is distinct from j.ocr_verification_set_fingerprint
     or i.duplicate_audit_run_id is distinct from j.duplicate_audit_run_id then raise exception 'classification_v6_input_stale'; end if;
  return jsonb_build_object(
    'job',jsonb_build_object('id',j.id,'article_id',j.article_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token,'classification_input_sha256',j.classification_input_sha256),
    'verified_crop_ocr_text',i.verified_text,
    'verified_text_sha256',i.verified_text_sha256,
    'category_catalog_fingerprint',i.category_catalog_fingerprint,
    'category_catalog',i.category_catalog_json
  );
end
$function$;

create or replace function public.fail_article_classification_job_v6(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare j public.article_classification_jobs_v4%rowtype;v_failures integer;v_next text;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found or j.classifier_version<>'article_category_profile_v6_verified_ocr_dual' or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'classification_v6_lease_invalid'; end if;
  v_failures:=j.attempt_count+1;
  v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_failures<4 then 'queued' else 'failed' end;
  update public.article_classification_jobs_v4 set status=v_next,attempt_count=v_failures,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error_message,'classification worker failed'),3000),last_error_class=case when p_retryable then 'worker_error' else 'structural' end,next_retry_at=null,finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;
  return jsonb_build_object('status',v_next,'failure_count',v_failures,'retry_scheduled',(v_next='queued'));
end
$function$;

create or replace function public.requeue_article_classification_job_v6(p_job_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare j public.article_classification_jobs_v4%rowtype;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found or j.classifier_version<>'article_category_profile_v6_verified_ocr_dual' or j.status not in ('needs_review','failed') then raise exception 'classification_v6_requeue_not_allowed'; end if;
  delete from public.article_category_memberships_v4 where profile_id in (select id from public.article_profiles_v4 where classification_job_id=j.id);
  delete from public.article_profiles_v4 where classification_job_id=j.id;
  delete from public.article_classification_stage_v6 where job_id=j.id;
  delete from public.article_classification_pass_runs_v4 where job_id=j.id;
  update public.article_classification_jobs_v4 set status='queued',attempt_count=0,active_pass_kind=null,lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,result_json='{}'::jsonb,finished_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','proofs_reset',true);
end
$function$;

revoke all on function public.enqueue_article_classification_jobs_v6() from public,anon,authenticated;
revoke all on function public.claim_article_classification_job_v6(integer) from public,anon,authenticated;
revoke all on function public.get_article_classification_input_v6(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_article_classification_job_v6(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.requeue_article_classification_job_v6(uuid) from public,anon,authenticated;
grant execute on function public.enqueue_article_classification_jobs_v6() to service_role;
grant execute on function public.claim_article_classification_job_v6(integer) to service_role;
grant execute on function public.get_article_classification_input_v6(uuid,uuid) to service_role;
grant execute on function public.fail_article_classification_job_v6(uuid,uuid,text,boolean) to service_role;
grant execute on function public.requeue_article_classification_job_v6(uuid) to service_role;

commit;