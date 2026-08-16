create or replace function public.request_inventory_v7_scheduler_tick_v1()
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'vault', 'net'
as $function$
declare
  s public.inventory_v7_scheduler_state_v1%rowtype;
  v_password text;
  v_request_id bigint;
  v_freeze uuid;
  v_work integer;
  v_recovery jsonb := jsonb_build_object('skipped',true,'reason','runnable_work_already_available');
  v_prior_recovery jsonb := jsonb_build_object('skipped',true,'reason','runnable_work_already_available');
  v_stable_mapping_recovery jsonb := jsonb_build_object('skipped',true,'reason','runnable_work_already_available');
  v_fully_mapped_timeout_recovery jsonb := jsonb_build_object('skipped',true,'reason','runnable_work_already_available');
begin
  select * into s from public.inventory_v7_scheduler_state_v1 where singleton=true;
  if not found or not s.enabled then return null; end if;
  if s.target_url <> 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/internal/inventory-v7-scheduler' then
    raise exception 'inventory_v7_scheduler_target_not_allowed';
  end if;
  if s.lease_token is not null and coalesce(s.lease_expires_at,'epoch'::timestamptz)>now() then return null; end if;

  select freeze_receipt_id into v_freeze
  from public.inventory_v3_execution_control_v1
  where singleton=true and enabled=true;
  if v_freeze is null then return null; end if;

  select count(*)::integer into v_work
  from public.source_page_article_inventory_jobs_v1 j
  where j.freeze_receipt_id=v_freeze
    and j.inventory_version='page_article_inventory_v4_recovered_ocr'
    and public.inventory_recovered_job_identity_ok_v1(j.id,v_freeze)
    and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<=now()));

  if v_work=0 then
    v_prior_recovery:=public.recover_inventory_v7_exact_prior_audited_third_pass_v1(5);

    select count(*)::integer into v_work
    from public.source_page_article_inventory_jobs_v1 j
    where j.freeze_receipt_id=v_freeze
      and j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and public.inventory_recovered_job_identity_ok_v1(j.id,v_freeze)
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<=now()));

    if v_work=0 then
      v_fully_mapped_timeout_recovery:=public.recover_inventory_v7_fully_mapped_timeouts_v1(4);
      v_recovery:=public.recover_inventory_v7_transient_timeouts_v1(2);

      select count(*)::integer into v_work
      from public.source_page_article_inventory_jobs_v1 j
      where j.freeze_receipt_id=v_freeze
        and j.inventory_version='page_article_inventory_v4_recovered_ocr'
        and public.inventory_recovered_job_identity_ok_v1(j.id,v_freeze)
        and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<=now()));
    end if;

    if v_work=0 then
      v_stable_mapping_recovery:=public.recover_inventory_v7_stable_historical_mappings_v1(10);

      select count(*)::integer into v_work
      from public.source_page_article_inventory_jobs_v1 j
      where j.freeze_receipt_id=v_freeze
        and j.inventory_version='page_article_inventory_v4_recovered_ocr'
        and public.inventory_recovered_job_identity_ok_v1(j.id,v_freeze)
        and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<=now()));
    end if;
  end if;

  if v_work=0 then return null; end if;

  select decrypted_secret into v_password
  from vault.decrypted_secrets
  where name='mj_report_worker_password'
  order by created_at desc
  limit 1;
  if coalesce(v_password,'')='' then raise exception 'mj_report_worker_password is missing from Vault'; end if;

  select net.http_post(
    url:=s.target_url,
    body:=jsonb_build_object(
      'transient_recovery',v_recovery,
      'exact_prior_recovery',v_prior_recovery,
      'stable_mapping_recovery',v_stable_mapping_recovery,
      'fully_mapped_timeout_recovery',v_fully_mapped_timeout_recovery
    ),
    params:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','x-app-password',v_password),
    timeout_milliseconds:=240000
  ) into v_request_id;
  return v_request_id;
end
$function$;

select cron.alter_job(
  job_id := 7,
  schedule := '* * * * *'
);
