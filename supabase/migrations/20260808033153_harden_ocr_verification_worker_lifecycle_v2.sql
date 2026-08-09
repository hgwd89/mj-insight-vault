begin;

create or replace function public.claim_ocr_verification_page_job_v2(p_lease_seconds integer default 240)
returns setof public.ocr_verification_page_jobs_v2 language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_token uuid:=gen_random_uuid();v_status text;
begin
  if (select source_region_gate from public.source_region_inventory_gate_v6)<>'passed' then raise exception 'ocr_verification_v2_source_regions_not_ready'; end if;
  update public.ocr_verification_page_jobs_v2
     set status='failed',error_message='worker lease expired too many times',finished_at=now(),updated_at=now(),lease_token=null,lease_expires_at=null
   where status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select id,status into v_id,v_status from public.ocr_verification_page_jobs_v2
  where (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now())) and failure_count<4
  order by requires_second_pass desc,created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.ocr_verification_page_jobs_v2 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,p_lease_seconds))),
    failure_count=failure_count+case when v_status='running' then 1 else 0 end,updated_at=now(),error_message=null where id=v_id;
  return query select * from public.ocr_verification_page_jobs_v2 where id=v_id;
end
$function$;

create or replace function public.requeue_ocr_verification_page_job_v2(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;
begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status not in ('needs_review','failed') then raise exception 'ocr_verification_v2_requeue_not_allowed'; end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id) then raise exception 'ocr_verification_v2_freeze_stale'; end if;
 delete from public.article_ocr_verifications_v1 where partition_job_id=j.partition_job_id;
 delete from public.ocr_verification_transcriptions_v2 where job_id=j.id;
 delete from public.ocr_verification_pass_runs_v2 where job_id=j.id;
 update public.ocr_verification_page_jobs_v2 set status='queued',failure_count=0,lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued','proofs_reset',true);
end
$function$;

revoke all on function public.requeue_ocr_verification_page_job_v2(uuid) from public,anon,authenticated;
grant execute on function public.requeue_ocr_verification_page_job_v2(uuid) to service_role;

commit;