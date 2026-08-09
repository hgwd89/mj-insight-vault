begin;

create or replace function public.enqueue_verified_theme_census_v7(p_article_batch_size integer default 10)
returns integer
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare a public.verified_theme_analysis_runs_v7%rowtype;r public.verified_article_review_corpus_receipts_v7%rowtype;v_size integer:=greatest(4,least(12,coalesce(p_article_batch_size,10)));v_candidates integer;v_count integer;
begin
  if (select candidate_gate from public.verified_theme_candidate_gate_v7)<>'passed' then raise exception 'verified_census_v7_candidate_gate_required'; end if;
  select ar.* into a from public.verified_theme_analysis_runs_v7 ar join public.verified_theme_candidate_gate_v7 g on g.analysis_run_id=ar.id and g.candidate_gate='passed';
  if a.id is null then raise exception 'verified_census_v7_analysis_missing'; end if;
  select * into r from public.current_verified_article_review_corpus_receipt_v7 where id=a.review_receipt_id;
  if r.id is null then raise exception 'verified_census_v7_review_receipt_stale'; end if;
  select count(*)::integer into v_candidates from public.verified_theme_candidates_v7 where analysis_run_id=a.id;
  if not exists(select 1 from public.verified_theme_census_batches_v7 where analysis_run_id=a.id) then
    with src as (
      select v.article_id,v.analysis_text_sha256,row_number() over(order by v.article_id) rn
      from public.formal_verified_article_text_v5 v
      join public.verified_article_reviews_v6 ar on ar.article_id=v.article_id and ar.classification_receipt_id=r.classification_receipt_id
    ),grp as (
      select ((rn-1)/v_size+1)::integer batch_index,array_agg(article_id order by article_id) article_ids,count(*)::integer article_count,
             encode(extensions.digest(convert_to(string_agg(article_id::text||':'||analysis_text_sha256,'|' order by article_id)||'|'||a.candidate_set_fingerprint,'UTF8'),'sha256'),'hex') fp
      from src group by ((rn-1)/v_size+1)::integer
    )
    insert into public.verified_theme_census_batches_v7(analysis_run_id,batch_index,article_ids,article_count,candidate_set_fingerprint,article_batch_fingerprint,status,finished_at)
    select a.id,batch_index,article_ids,article_count,a.candidate_set_fingerprint,fp,case when v_candidates=0 then 'completed' else 'queued' end,case when v_candidates=0 then now() else null end from grp order by batch_index;
  end if;
  if v_candidates=0 then
    insert into public.verified_theme_census_article_outcomes_v7(analysis_run_id,batch_id,article_id,candidate_set_fingerprint,matched_candidate_ids,updated_at)
    select a.id,b.id,u.article_id,a.candidate_set_fingerprint,'{}'::uuid[],now() from public.verified_theme_census_batches_v7 b cross join lateral unnest(b.article_ids) u(article_id) where b.analysis_run_id=a.id
    on conflict(analysis_run_id,article_id) do update set batch_id=excluded.batch_id,candidate_set_fingerprint=excluded.candidate_set_fingerprint,matched_candidate_ids='{}'::uuid[],updated_at=now();
  end if;
  update public.verified_theme_analysis_runs_v7 set status='census',updated_at=now() where id=a.id and status='candidates_ready';
  select count(*)::integer into v_count from public.verified_theme_census_batches_v7 where analysis_run_id=a.id;
  return v_count;
end
$function$;

create or replace function public.claim_verified_theme_census_batch_v7(p_lease_seconds integer default 240)
returns setof public.verified_theme_census_batches_v7
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_run uuid;v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  select analysis_run_id into v_run from public.verified_theme_candidate_gate_v7 where candidate_gate='passed'; if v_run is null then return; end if;
  update public.verified_theme_census_batches_v7 set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='census lease expired too many times',finished_at=now(),updated_at=now()
   where analysis_run_id=v_run and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select b.id,b.status,
         case when not exists(select 1 from public.verified_theme_census_passes_v7 p where p.batch_id=b.id and p.pass_kind='mapper') then 'mapper'
              when not exists(select 1 from public.verified_theme_census_passes_v7 p where p.batch_id=b.id and p.pass_kind='critic') then 'critic' else null end
    into v_id,v_status,v_pass
  from public.verified_theme_census_batches_v7 b
  where b.analysis_run_id=v_run and (b.status='queued' or (b.status='running' and coalesce(b.lease_expires_at,'epoch'::timestamptz)<now())) and b.failure_count<4
    and (not exists(select 1 from public.verified_theme_census_passes_v7 p where p.batch_id=b.id and p.pass_kind='mapper') or not exists(select 1 from public.verified_theme_census_passes_v7 p where p.batch_id=b.id and p.pass_kind='critic'))
  order by b.batch_index for update skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_census_batches_v7 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_census_batches_v7 where id=v_id;
end
$function$;

create or replace function public.get_verified_theme_census_input_v7(p_batch_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare b public.verified_theme_census_batches_v7%rowtype;a public.verified_theme_analysis_runs_v7%rowtype;r public.verified_article_review_corpus_receipts_v7%rowtype;v_n integer;v_fp text;v_articles jsonb;v_candidates jsonb;
begin
  select * into b from public.verified_theme_census_batches_v7 where id=p_batch_id;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'verified_census_v7_lease_invalid'; end if;
  select * into a from public.verified_theme_analysis_runs_v7 where id=b.analysis_run_id;
  select * into r from public.current_verified_article_review_corpus_receipt_v7 where id=a.review_receipt_id;
  if r.id is null or a.candidate_set_fingerprint<>b.candidate_set_fingerprint then raise exception 'verified_census_v7_input_stale'; end if;
  with src as (
    select v.article_id,v.analysis_text,v.analysis_text_sha256
    from public.formal_verified_article_text_v5 v where v.article_id=any(b.article_ids)
  )
  select count(*)::integer,encode(extensions.digest(convert_to(string_agg(article_id::text||':'||analysis_text_sha256,'|' order by article_id)||'|'||a.candidate_set_fingerprint,'UTF8'),'sha256'),'hex'),
         jsonb_agg(jsonb_build_object('article_id',article_id,'verified_crop_ocr_text',analysis_text,'verified_text_sha256',analysis_text_sha256) order by article_id)
    into v_n,v_fp,v_articles from src;
  if v_n<>b.article_count or v_fp<>b.article_batch_fingerprint then raise exception 'verified_census_v7_article_batch_stale'; end if;
  select jsonb_agg(jsonb_build_object('candidate_id',c.id,'theme_key',c.theme_key,'title',c.title,'definition',c.definition,'inclusion_rule',c.inclusion_rule,'exclusion_rule',c.exclusion_rule,'subject',c.subject,'measurement',c.measurement) order by c.theme_key)
    into v_candidates from public.verified_theme_candidates_v7 c where c.analysis_run_id=a.id;
  if coalesce(jsonb_array_length(v_candidates),0)=0 then raise exception 'verified_census_v7_candidates_missing'; end if;
  return jsonb_build_object('batch',jsonb_build_object('id',b.id,'analysis_run_id',b.analysis_run_id,'batch_index',b.batch_index,'pass_kind',b.active_pass_kind,'lease_token',b.lease_token,'candidate_set_fingerprint',b.candidate_set_fingerprint,'article_batch_fingerprint',b.article_batch_fingerprint),'candidates',v_candidates,'articles',v_articles);
end
$function$;

create or replace function public.fail_verified_theme_census_batch_v7(p_batch_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare b public.verified_theme_census_batches_v7%rowtype;v_n integer;v_next text;
begin
 select * into b from public.verified_theme_census_batches_v7 where id=p_batch_id for update;
 if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token then raise exception 'verified_census_v7_lease_invalid'; end if;
 v_n:=b.failure_count+1;v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_n<4 then 'queued' else 'failed' end;
 update public.verified_theme_census_batches_v7 set status=v_next,failure_count=v_n,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'census worker failed'),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=b.id;
 return jsonb_build_object('status',v_next,'failure_count',v_n,'retry_scheduled',(v_next='queued'));
end
$function$;

revoke all on function public.enqueue_verified_theme_census_v7(integer) from public,anon,authenticated;
revoke all on function public.claim_verified_theme_census_batch_v7(integer) from public,anon,authenticated;
revoke all on function public.get_verified_theme_census_input_v7(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_verified_theme_census_batch_v7(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_verified_theme_census_v7(integer) to service_role;
grant execute on function public.claim_verified_theme_census_batch_v7(integer) to service_role;
grant execute on function public.get_verified_theme_census_input_v7(uuid,uuid) to service_role;
grant execute on function public.fail_verified_theme_census_batch_v7(uuid,uuid,text,boolean) to service_role;
commit;