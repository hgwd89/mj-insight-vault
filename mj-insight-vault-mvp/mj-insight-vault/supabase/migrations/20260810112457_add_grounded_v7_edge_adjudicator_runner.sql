-- Canonical copy of the Grounded V7 adjudicator fallback runner applied to Supabase.
-- The Edge runtime is intentionally separate from the normal inventory claim path.

create table if not exists public.inventory_v7_edge_invocations_v1 (
  id uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  max_jobs integer not null default 1 check (max_jobs between 1 and 4),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.inventory_v7_edge_invocations_v1 enable row level security;
revoke all on table public.inventory_v7_edge_invocations_v1 from public,anon,authenticated;
grant select,insert,update,delete on table public.inventory_v7_edge_invocations_v1 to service_role;

create or replace function public.claim_inventory_v7_edge_invocation_v1(p_token text)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  v_hash text;
  v_max integer;
begin
  if coalesce(length(p_token),0)<32 then raise exception 'inventory_v7_edge_token_invalid'; end if;
  v_hash:=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  update public.inventory_v7_edge_invocations_v1
     set used_at=now()
   where token_sha256=v_hash and used_at is null and expires_at>now()
   returning max_jobs into v_max;
  if v_max is null then raise exception 'inventory_v7_edge_invocation_missing_or_used'; end if;
  return v_max;
end
$function$;

revoke all on function public.claim_inventory_v7_edge_invocation_v1(text) from public,anon,authenticated;
grant execute on function public.claim_inventory_v7_edge_invocation_v1(text) to service_role;

create or replace function public.claim_grounded_v7_adjudicator_job_v1(p_lease_seconds integer default 300)
returns setof public.source_page_article_inventory_jobs_v1
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_id uuid;
  v_status text;
  v_token uuid:=gen_random_uuid();
  v_freeze uuid;
  v_pages integer;
  v_lease integer;
begin
  select freeze_receipt_id,recovery_completed_pages
    into v_freeze,v_pages
  from public.inventory_v3_execution_control_v1
  where singleton=true;

  if v_freeze is null or v_pages<>531 then return; end if;
  if (select count(*) from public.source_page_ocr_recovery_jobs_v1 where status='completed')<>531
     or exists(select 1 from public.source_page_ocr_recovery_jobs_v1 where status<>'completed') then
    return;
  end if;

  select j.id,j.status into v_id,v_status
  from public.source_page_article_inventory_jobs_v1 j
  where j.inventory_version='page_article_inventory_v4_recovered_ocr'
    and j.freeze_receipt_id=v_freeze
    and j.requires_third_pass
    and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
    and j.attempt_count<4
    and exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='mapper')
    and exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='critic')
    and exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=j.id and e.pass_kind='mapper')
    and exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=j.id and e.pass_kind='critic')
    and not exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=j.id and e.pass_kind='adjudicator')
    and not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 c where c.job_id=j.id)
    and not exists(select 1 from public.source_region_materialization_receipts_v6 m where m.inventory_job_id=j.id)
  order by j.attempt_count,j.block_count,j.created_at,j.id
  for update skip locked
  limit 1;

  if v_id is null then return; end if;

  if exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=v_id and p.pass_kind='adjudicator') then
    delete from public.source_page_article_inventory_groups_v1 where job_id=v_id and pass_kind='adjudicator';
    delete from public.source_page_article_inventory_pass_runs_v1 where job_id=v_id and pass_kind='adjudicator';
  end if;

  v_lease:=greatest(180,least(420,coalesce(p_lease_seconds,300)));
  update public.source_page_article_inventory_jobs_v1
     set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>v_lease),
         attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,
         error_message=null,updated_at=now()
   where id=v_id;

  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end
$function$;

revoke all on function public.claim_grounded_v7_adjudicator_job_v1(integer) from public,anon,authenticated;
grant execute on function public.claim_grounded_v7_adjudicator_job_v1(integer) to service_role;

create or replace function public.request_inventory_v7_adjudicator_v1(
  p_max_jobs integer default 1,
  p_timeout_milliseconds integer default 170000
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions','net'
as $function$
declare
  v_token text;
  v_hash text;
  v_id uuid;
  v_request bigint;
  v_endpoint text:='https://wqbjtvepnavkqdshppau.supabase.co/functions/v1/inventory-v7-adjudicator-drain';
  v_jobs integer:=greatest(1,least(4,coalesce(p_max_jobs,1)));
begin
  v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  v_hash:=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex');
  insert into public.inventory_v7_edge_invocations_v1(token_sha256,max_jobs,expires_at)
  values(v_hash,v_jobs,now()+interval '10 minutes') returning id into v_id;
  v_request:=net.http_post(
    url:=v_endpoint,
    body:=jsonb_build_object('token',v_token),
    headers:='{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds:=greatest(30000,least(180000,coalesce(p_timeout_milliseconds,170000)))
  );
  return jsonb_build_object('invocation_id',v_id,'request_id',v_request,'max_jobs',v_jobs);
end
$function$;

revoke all on function public.request_inventory_v7_adjudicator_v1(integer,integer) from public,anon,authenticated;
grant execute on function public.request_inventory_v7_adjudicator_v1(integer,integer) to service_role;

create or replace function public.cleanup_inventory_v7_edge_invocations_v1()
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare v_count integer;
begin
  delete from public.inventory_v7_edge_invocations_v1 where expires_at<now()-interval '1 hour';
  get diagnostics v_count=row_count;
  return v_count;
end
$function$;

revoke all on function public.cleanup_inventory_v7_edge_invocations_v1() from public,anon,authenticated;
grant execute on function public.cleanup_inventory_v7_edge_invocations_v1() to service_role;
