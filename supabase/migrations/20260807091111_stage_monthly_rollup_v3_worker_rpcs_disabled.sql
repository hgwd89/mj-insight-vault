create or replace function public.enqueue_monthly_rollup_v3(p_month_key text,p_force boolean default false)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare v_count integer; v_ids uuid[]; v_keep_ready boolean;
begin
  if p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception using errcode='22023',message='invalid_month_key'; end if;
  select count(*)::integer,array_agg(id order by id::text) into v_count,v_ids from public.formal_month_articles_v3 where month_key=p_month_key;
  if coalesce(v_count,0)=0 then raise exception using errcode='P0002',message='formal_month_has_no_articles'; end if;

  select coalesce(r.status='ready' and public.monthly_rollup_v3_payload_integrity_v2(r.month_key,r.article_count,r.article_ids,r.summary_json),false)
    into v_keep_ready from public.monthly_rollups r where r.month_key=p_month_key;

  insert into public.monthly_rollups(month_key,article_count,article_ids,status,rollup_model,summary_text,summary_json,error_message,generated_at,attempt_count,next_retry_at,lease_token,lease_expires_at,heartbeat_at,updated_at)
  values(p_month_key,v_count,v_ids,'queued','', 'Monthly rollup V3 queued.','{}'::jsonb,null,null,0,null,null,null,null,now())
  on conflict(month_key) do update set
    article_count=v_count,
    article_ids=v_ids,
    status=case when monthly_rollups.status='running' and monthly_rollups.lease_expires_at>now() then monthly_rollups.status when not p_force and v_keep_ready then 'ready' else 'queued' end,
    rollup_model=case when not p_force and v_keep_ready then monthly_rollups.rollup_model else '' end,
    summary_text=case when not p_force and v_keep_ready then monthly_rollups.summary_text else 'Monthly rollup V3 queued.' end,
    summary_json=case when not p_force and v_keep_ready then monthly_rollups.summary_json else '{}'::jsonb end,
    representative_article_ids=case when not p_force and v_keep_ready then monthly_rollups.representative_article_ids else '{}'::uuid[] end,
    evidence_article_ids=case when not p_force and v_keep_ready then monthly_rollups.evidence_article_ids else '{}'::uuid[] end,
    error_message=null,
    generated_at=case when not p_force and v_keep_ready then monthly_rollups.generated_at else null end,
    attempt_count=0,next_retry_at=null,
    lease_token=case when monthly_rollups.status='running' and monthly_rollups.lease_expires_at>now() then monthly_rollups.lease_token else null end,
    lease_expires_at=case when monthly_rollups.status='running' and monthly_rollups.lease_expires_at>now() then monthly_rollups.lease_expires_at else null end,
    heartbeat_at=case when monthly_rollups.status='running' and monthly_rollups.lease_expires_at>now() then monthly_rollups.heartbeat_at else null end,
    updated_at=now();
  return query select * from public.monthly_rollups where month_key=p_month_key;
end;
$function$;

create or replace function public.claim_monthly_rollup_v3(p_month_key text,p_lease_seconds integer default 240)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if exists(select 1 from public.monthly_rollups a where a.status='running' and a.lease_expires_at>now() and a.month_key<>p_month_key) then return; end if;
  return query update public.monthly_rollups r
  set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>greatest(60,least(coalesce(p_lease_seconds,240),600))),heartbeat_at=now(),updated_at=now()
  where r.month_key=p_month_key and (r.next_retry_at is null or r.next_retry_at<=now()) and (r.status='queued' or (r.status='running' and coalesce(r.lease_expires_at,'epoch'::timestamptz)<=now()))
    and not exists(select 1 from public.monthly_rollups a where a.id<>r.id and a.status='running' and a.lease_expires_at>now())
  returning r.*;
end;
$function$;

create or replace function public.claim_next_monthly_rollup_v3(p_lease_seconds integer default 240)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if exists(select 1 from public.monthly_rollups a where a.status='running' and a.lease_expires_at>now()) then return; end if;
  return query with candidate as (
    select r.id from public.monthly_rollups r
    where (r.next_retry_at is null or r.next_retry_at<=now()) and (r.status='queued' or (r.status='running' and coalesce(r.lease_expires_at,'epoch'::timestamptz)<=now()))
    order by case when r.status='running' then 0 else 1 end,r.updated_at,r.month_key for update skip locked limit 1
  ) update public.monthly_rollups r
  set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>greatest(60,least(coalesce(p_lease_seconds,240),600))),heartbeat_at=now(),updated_at=now()
  from candidate c where r.id=c.id and not exists(select 1 from public.monthly_rollups a where a.id<>r.id and a.status='running' and a.lease_expires_at>now()) returning r.*;
end;
$function$;

insert into public.pipeline_runner_state(state_key,state_value,updated_at)
values('monthly_rollup_v3_deployment',jsonb_build_object('status','disabled','reason','awaiting_v3_application_deployment'),now())
on conflict(state_key) do update set state_value=excluded.state_value,updated_at=excluded.updated_at;

create or replace function public.kick_monthly_rollup_worker_v3()
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions','vault'
as $function$
declare v_password text; v_request_id bigint; v_enabled boolean:=false;
begin
  select lower(coalesce(state_value->>'status','disabled'))='enabled' into v_enabled from public.pipeline_runner_state where state_key='monthly_rollup_v3_deployment';
  if not coalesce(v_enabled,false) then return null; end if;
  if exists(select 1 from public.monthly_rollups a where a.status='running' and a.lease_expires_at>now()) then return null; end if;
  if not exists(select 1 from public.monthly_rollups r where (r.next_retry_at is null or r.next_retry_at<=now()) and (r.status='queued' or (r.status='running' and coalesce(r.lease_expires_at,'epoch'::timestamptz)<=now()))) then return null; end if;
  select decrypted_secret into v_password from vault.decrypted_secrets where name='mj_report_worker_password' order by created_at desc limit 1;
  if coalesce(v_password,'')='' then raise exception 'mj_report_worker_password is missing from Vault'; end if;
  v_request_id:=net.http_post(url:='https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/rollups/monthly/worker',body:='{}'::jsonb,headers:=jsonb_build_object('Content-Type','application/json','x-app-password',v_password),timeout_milliseconds:=240000);
  return v_request_id;
end;
$function$;

revoke all on function public.enqueue_monthly_rollup_v3(text,boolean) from public,anon,authenticated;
revoke all on function public.claim_monthly_rollup_v3(text,integer) from public,anon,authenticated;
revoke all on function public.claim_next_monthly_rollup_v3(integer) from public,anon,authenticated;
revoke all on function public.kick_monthly_rollup_worker_v3() from public,anon,authenticated;
grant execute on function public.enqueue_monthly_rollup_v3(text,boolean) to postgres,service_role;
grant execute on function public.claim_monthly_rollup_v3(text,integer) to postgres,service_role;
grant execute on function public.claim_next_monthly_rollup_v3(integer) to postgres,service_role;
grant execute on function public.kick_monthly_rollup_worker_v3() to postgres,service_role;