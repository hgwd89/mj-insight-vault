begin;

alter table public.source_grounded_duplicate_audit_runs_v5
  add column if not exists ocr_receipt_id uuid references public.verified_ocr_corpus_receipts_v5(id) on delete cascade,
  add column if not exists ocr_verification_set_fingerprint text;
create index if not exists source_grounded_duplicate_audit_runs_v5_ocr_receipt_idx on public.source_grounded_duplicate_audit_runs_v5(ocr_receipt_id);

create or replace function public.verified_embedding_set_fingerprint_v6()
returns table(
  ocr_receipt_id uuid,
  ocr_verification_set_fingerprint text,
  embedding_count integer,
  embedding_set_fingerprint text
)
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $function$
  with r as (select * from public.current_verified_ocr_corpus_receipt_v5),
  e as (
    select count(*)::integer embedding_count,
           encode(extensions.digest(convert_to(coalesce(string_agg(
             x.article_id::text||':'||x.embedding_input_sha256||':'||coalesce(x.provider_request_id,'')||':'||coalesce(x.response_sha256,''),
             '|' order by x.article_id::text),''),'UTF8'),'sha256'),'hex') embedding_set_fingerprint
    from public.formal_article_embeddings_v5 x
  )
  select r.id,r.verification_set_fingerprint,e.embedding_count,e.embedding_set_fingerprint
  from r cross join e
$function$;
revoke all on function public.verified_embedding_set_fingerprint_v6() from public,anon,authenticated;
grant execute on function public.verified_embedding_set_fingerprint_v6() to service_role;

create or replace function public.create_source_grounded_duplicate_audit_run_v6()
returns uuid
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare
  v_freeze uuid;
  v_article_count integer;
  v_source_fp text;
  v_emb record;
  v_id uuid;
begin
  if (select embedding_gate from public.article_embedding_quality_gate_v5)<>'passed' then
    raise exception 'duplicate_v6_verified_embedding_gate_required';
  end if;
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'duplicate_v6_freeze_required'; end if;
  select article_count,verification_set_fingerprint into v_article_count,v_source_fp from public.current_verified_ocr_corpus_receipt_v5;
  if v_article_count is null or v_article_count<=0 or coalesce(v_source_fp,'')='' then raise exception 'duplicate_v6_verified_ocr_receipt_required'; end if;
  select * into v_emb from public.verified_embedding_set_fingerprint_v6();
  if v_emb.ocr_receipt_id is null or v_emb.embedding_count<>v_article_count or coalesce(v_emb.embedding_set_fingerprint,'')='' then
    raise exception 'duplicate_v6_embedding_receipt_mismatch';
  end if;
  insert into public.source_grounded_duplicate_audit_runs_v5(
    freeze_receipt_id,corpus_article_count,source_grounded_fingerprint,strict_embedding_count,embedding_set_fingerprint,
    detection_version,status,candidate_count,distinct_count,duplicate_count,unresolved_count,
    ocr_receipt_id,ocr_verification_set_fingerprint,created_at,updated_at
  ) values(
    v_freeze,v_article_count,v_source_fp,v_emb.embedding_count,v_emb.embedding_set_fingerprint,
    'verified_ocr_duplicate_audit_v6','queued',0,0,0,0,
    v_emb.ocr_receipt_id,v_emb.ocr_verification_set_fingerprint,now(),now()
  )
  on conflict(freeze_receipt_id,source_grounded_fingerprint,embedding_set_fingerprint,detection_version)
  do update set ocr_receipt_id=excluded.ocr_receipt_id,ocr_verification_set_fingerprint=excluded.ocr_verification_set_fingerprint,updated_at=now()
  returning id into v_id;
  return v_id;
end
$function$;

create or replace function public.populate_source_grounded_duplicate_candidates_v6(p_run_id uuid)
returns integer
language plpgsql security definer
set search_path=pg_catalog,public,extensions
as $function$
declare
  r public.source_grounded_duplicate_audit_runs_v5%rowtype;
  v_emb record;
  v_current_ocr public.verified_ocr_corpus_receipts_v5%rowtype;
  v_count integer;
begin
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=p_run_id for update;
  if not found or r.detection_version<>'verified_ocr_duplicate_audit_v6' or r.status not in ('queued','running') then
    raise exception 'duplicate_v6_run_not_populatable';
  end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=r.freeze_receipt_id) then raise exception 'duplicate_v6_freeze_stale'; end if;
  select * into v_current_ocr from public.current_verified_ocr_corpus_receipt_v5;
  select * into v_emb from public.verified_embedding_set_fingerprint_v6();
  if v_current_ocr.id is distinct from r.ocr_receipt_id
     or v_current_ocr.verification_set_fingerprint is distinct from r.ocr_verification_set_fingerprint
     or v_current_ocr.article_count<>r.corpus_article_count
     or v_emb.embedding_count<>r.strict_embedding_count
     or v_emb.embedding_set_fingerprint is distinct from r.embedding_set_fingerprint then
    raise exception 'duplicate_v6_input_stale';
  end if;

  update public.source_grounded_duplicate_audit_runs_v5 set status='running',started_at=coalesce(started_at,now()),updated_at=now() where id=r.id;
  delete from public.source_grounded_duplicate_review_passes_v5 where run_id=r.id;
  delete from public.source_grounded_duplicate_candidates_v5 where run_id=r.id;

  with e as materialized (
    select e.article_id,e.embedding_vector,a.headline,a.article_date,
           e.source_region_sha256,p.page_identity_source_image_id
    from public.formal_article_embeddings_v5 e
    join public.formal_corpus_articles_v1 a on a.id=e.article_id
    join public.source_page_partition_jobs_v3 p on p.id=e.source_partition_job_id
    where p.partition_version='source_region_v6_inventory_consensus' and p.status='completed'
  ), nearest as (
    select a.article_id a_id,n.article_id b_id,
           1-(a.embedding_vector <=> n.embedding_vector) semantic_similarity,
           similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(n.headline)) headline_similarity,
           a.article_date=n.article_date same_date,
           a.source_region_sha256=n.source_region_sha256 same_region,
           a.page_identity_source_image_id=n.page_identity_source_image_id same_page
    from e a
    cross join lateral (
      select b.* from e b where b.article_id<>a.article_id order by a.embedding_vector <=> b.embedding_vector limit 12
    ) n
  ), norm as (
    select least(a_id,b_id) a_id,greatest(a_id,b_id) b_id,
           max(semantic_similarity) semantic_similarity,max(headline_similarity) headline_similarity,
           bool_or(same_date) same_date,bool_or(same_region) same_region,bool_or(same_page) same_page
    from nearest
    group by least(a_id,b_id),greatest(a_id,b_id)
  ), candidates as (
    select *,array_remove(array[
      case when same_region then 'same_source_region_sha' end,
      case when semantic_similarity>=0.985 then 'semantic_ge_0985' end,
      case when semantic_similarity>=0.970 and headline_similarity>=0.25 then 'semantic_ge_097_headline_ge_025' end,
      case when same_date and headline_similarity>=0.55 then 'same_date_headline_ge_055' end
    ],null)::text[] reasons
    from norm
    where same_region
       or semantic_similarity>=0.985
       or (semantic_similarity>=0.970 and headline_similarity>=0.25)
       or (same_date and headline_similarity>=0.55)
  ), ins as (
    insert into public.source_grounded_duplicate_candidates_v5(
      run_id,article_id_a,article_id_b,semantic_similarity,headline_similarity,same_date,same_source_region_hash,same_page_identity,detection_reasons
    )
    select r.id,a_id,b_id,semantic_similarity,headline_similarity,same_date,same_region,same_page,reasons from candidates
    on conflict do nothing returning 1
  )
  select count(*)::integer into v_count from ins;

  update public.source_grounded_duplicate_audit_runs_v5
  set candidate_count=v_count,
      status=case when v_count=0 then 'completed' else 'reviewing' end,
      distinct_count=case when v_count=0 then 0 else distinct_count end,
      duplicate_count=0,
      unresolved_count=case when v_count=0 then 0 else v_count end,
      finished_at=case when v_count=0 then now() else null end,
      updated_at=now()
  where id=r.id;
  return v_count;
end
$function$;

create or replace function public.finalize_source_grounded_duplicate_audit_v6(p_run_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_candidates integer;v_distinct integer;v_duplicate integer;v_unresolved integer;v_emb record;v_ocr public.verified_ocr_corpus_receipts_v5%rowtype;
begin
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=p_run_id for update;
  if not found or r.detection_version<>'verified_ocr_duplicate_audit_v6' or r.status not in ('reviewing','running') then raise exception 'duplicate_v6_run_not_finalizable'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=r.freeze_receipt_id) then raise exception 'duplicate_v6_freeze_stale'; end if;
  select * into v_ocr from public.current_verified_ocr_corpus_receipt_v5;
  select * into v_emb from public.verified_embedding_set_fingerprint_v6();
  if v_ocr.id is distinct from r.ocr_receipt_id or v_ocr.verification_set_fingerprint is distinct from r.ocr_verification_set_fingerprint or v_emb.embedding_set_fingerprint is distinct from r.embedding_set_fingerprint then raise exception 'duplicate_v6_input_stale'; end if;
  select count(*)::integer into v_candidates from public.source_grounded_duplicate_candidates_v5 where run_id=r.id;
  with x as (
    select c.article_id_a,c.article_id_b,
           max(p.disposition) filter(where p.pass_kind='reviewer') reviewer_disp,
           max(p.disposition) filter(where p.pass_kind='critic') critic_disp,
           max(p.canonical_article_id) filter(where p.pass_kind='reviewer') reviewer_canonical,
           max(p.canonical_article_id) filter(where p.pass_kind='critic') critic_canonical,
           count(p.*)::integer pass_count
    from public.source_grounded_duplicate_candidates_v5 c
    left join public.source_grounded_duplicate_review_passes_v5 p using(run_id,article_id_a,article_id_b)
    where c.run_id=r.id group by c.article_id_a,c.article_id_b
  ), classified as (
    select *,case when pass_count<>2 then 'unresolved' when reviewer_disp<>critic_disp then 'unresolved' when reviewer_disp='duplicate' and reviewer_canonical is distinct from critic_canonical then 'unresolved' else reviewer_disp end final_disp from x
  )
  select count(*) filter(where final_disp='distinct')::integer,
         count(*) filter(where final_disp='duplicate')::integer,
         count(*) filter(where final_disp='unresolved')::integer
  into v_distinct,v_duplicate,v_unresolved from classified;
  update public.source_grounded_duplicate_audit_runs_v5
  set candidate_count=v_candidates,distinct_count=coalesce(v_distinct,0),duplicate_count=coalesce(v_duplicate,0),unresolved_count=coalesce(v_unresolved,0),status='completed',finished_at=now(),updated_at=now()
  where id=r.id;
  return jsonb_build_object('status','completed','candidate_count',v_candidates,'distinct_count',coalesce(v_distinct,0),'duplicate_count',coalesce(v_duplicate,0),'unresolved_count',coalesce(v_unresolved,0));
end
$function$;

create or replace view public.source_grounded_duplicate_gate_v6
with (security_invoker=true)
as
with emb as (select * from public.verified_embedding_set_fingerprint_v6()),
current_run as (
  select r.*
  from public.source_grounded_duplicate_audit_runs_v5 r
  join emb e on e.ocr_receipt_id=r.ocr_receipt_id
            and e.ocr_verification_set_fingerprint=r.ocr_verification_set_fingerprint
            and e.embedding_set_fingerprint=r.embedding_set_fingerprint
            and e.embedding_count=r.strict_embedding_count
  where r.detection_version='verified_ocr_duplicate_audit_v6'
  order by r.created_at desc limit 1
)
select r.id audit_run_id,r.candidate_count candidate_pair_count,r.distinct_count reviewed_distinct_pair_count,
       r.duplicate_count reviewed_duplicate_pair_count,r.unresolved_count unresolved_pair_count,
       case when (select embedding_gate from public.article_embedding_quality_gate_v5)<>'passed' then 'failed'
            when r.id is null then 'failed'
            when r.status<>'completed' then 'failed'
            when r.duplicate_count>0 or r.unresolved_count>0 or r.distinct_count<>r.candidate_count then 'failed'
            else 'passed' end duplicate_gate,
       case when (select embedding_gate from public.article_embedding_quality_gate_v5)<>'passed' then 'verified_embeddings_required'
            when r.id is null then 'verified_embedding_duplicate_audit_required'
            when r.status<>'completed' then 'verified_embedding_duplicate_audit_incomplete'
            when r.duplicate_count>0 then 'duplicate_articles_require_corpus_fix_and_refreeze'
            when r.unresolved_count>0 then 'duplicate_candidates_unresolved'
            when r.distinct_count<>r.candidate_count then 'duplicate_review_incomplete'
            else 'passed' end gate_reason
from (select 1) x left join current_run r on true;

revoke all on function public.create_source_grounded_duplicate_audit_run_v6() from public,anon,authenticated;
revoke all on function public.populate_source_grounded_duplicate_candidates_v6(uuid) from public,anon,authenticated;
revoke all on function public.finalize_source_grounded_duplicate_audit_v6(uuid) from public,anon,authenticated;
grant execute on function public.create_source_grounded_duplicate_audit_run_v6() to service_role;
grant execute on function public.populate_source_grounded_duplicate_candidates_v6(uuid) to service_role;
grant execute on function public.finalize_source_grounded_duplicate_audit_v6(uuid) to service_role;
revoke execute on function public.create_source_grounded_duplicate_audit_run_v5() from service_role;
revoke execute on function public.populate_source_grounded_duplicate_candidates_v5(uuid) from service_role;
revoke execute on function public.finalize_source_grounded_duplicate_audit_v5(uuid) from service_role;

revoke all on public.source_grounded_duplicate_gate_v6 from public,anon,authenticated;
grant select on public.source_grounded_duplicate_gate_v6 to service_role;

commit;