create function public.renew_source_page_partition_job_lease_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 360
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_seconds integer:=greatest(120,least(600,coalesce(p_lease_seconds,360)));
begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id for update;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'partition_v3_job_lease_invalid'; end if;
  if j.lease_expires_at is null or j.lease_expires_at<now() then raise exception 'partition_v3_job_lease_expired'; end if;

  update public.source_page_partition_jobs_v3
  set lease_expires_at=now()+make_interval(secs=>v_seconds),updated_at=now()
  where id=j.id;

  return jsonb_build_object('status','renewed','job_id',j.id,'lease_seconds',v_seconds,'lease_expires_at',now()+make_interval(secs=>v_seconds));
end $$;

create function public.replace_article_source_grounding_reviews_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_current_freeze uuid;
  v_mapper_count integer;
  v_critic_count integer;
  v_low_conf integer;
  v_disagree integer;
  v_expected_weak integer;
  v_input_count integer;
  v_distinct_articles integer;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id for update;
  if not found then raise exception 'grounding_v3_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'grounding_v3_job_lease_invalid'; end if;
  if jsonb_typeof(p_rows)<>'array' then raise exception 'grounding_v3_rows_must_be_array'; end if;

  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v1 where freeze_gate='passed';
  if v_current_freeze is null or v_current_freeze<>j.freeze_receipt_id then raise exception 'grounding_v3_freeze_stale'; end if;

  select count(*) filter(where pass_kind='mapper')::integer,
         count(*) filter(where pass_kind='critic')::integer,
         count(*) filter(where confidence<0.80)::integer
    into v_mapper_count,v_critic_count,v_low_conf
  from public.source_page_partition_proposals_v3
  where job_id=j.id;

  select count(*)::integer into v_disagree
  from public.source_page_partition_proposals_v3 m
  join public.source_page_partition_proposals_v3 c
    on c.job_id=m.job_id and c.block_index=m.block_index and c.pass_kind='critic'
  where m.job_id=j.id and m.pass_kind='mapper'
    and (m.assignment_kind<>c.assignment_kind or m.article_id is distinct from c.article_id);

  if v_mapper_count<>j.block_count or v_critic_count<>j.block_count or v_low_conf>0 or v_disagree>0 then
    raise exception 'grounding_v3_requires_complete_agreed_partition';
  end if;

  with page_articles as (
    select f.id,f.headline,a.analysis_body_clean_sha256
    from public.formal_corpus_articles_v1 f
    join public.articles a on a.id=f.id
    join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
    where m.page_identity_source_image_id=j.page_identity_source_image_id
  ), regions as (
    select f.id,
           max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))) headline_sim
    from page_articles f
    join public.source_page_partition_proposals_v3 p
      on p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id
    join public.source_ocr_blocks_v1 b
      on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
    group by f.id
  )
  select count(*)::integer into v_expected_weak from regions where coalesce(headline_sim,0)<0.20;

  select count(*)::integer,count(distinct article_id)::integer
    into v_input_count,v_distinct_articles
  from jsonb_to_recordset(p_rows) as x(
    article_id uuid,
    grounding_decision text,
    shared_terms text[],
    reason text,
    grounding_model text
  );

  if v_input_count<>v_distinct_articles then raise exception 'grounding_v3_duplicate_article_rows'; end if;
  if v_input_count<>v_expected_weak then raise exception 'grounding_v3_row_count_mismatch expected % got %',v_expected_weak,v_input_count; end if;

  if exists(
    with weak as (
      select f.id
      from public.formal_corpus_articles_v1 f
      join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
      where m.page_identity_source_image_id=j.page_identity_source_image_id
        and coalesce((
          select max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text)))
          from public.source_page_partition_proposals_v3 p
          join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
          where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id
        ),0)<0.20
    ), supplied as (
      select article_id from jsonb_to_recordset(p_rows) as x(article_id uuid,grounding_decision text,shared_terms text[],reason text,grounding_model text)
    )
    select 1 from (
      (select id from weak except select article_id from supplied)
      union all
      (select article_id from supplied except select id from weak)
    ) d limit 1
  ) then raise exception 'grounding_v3_article_set_mismatch'; end if;

  delete from public.article_source_grounding_reviews_v3 where partition_job_id=j.id;

  insert into public.article_source_grounding_reviews_v3(
    article_id,evidence_source_image_id,review_version,headline_similarity,shared_terms,
    mapper_model,critic_model,mapper_decision,critic_decision,review_reason,
    partition_job_id,freeze_receipt_id,article_clean_body_sha256,source_ocr_sha256,region_sha256,
    grounding_model,grounding_decision,updated_at
  )
  select f.id,
         j.evidence_source_image_id,
         'source_grounding_v3',
         r.headline_sim,
         coalesce(x.shared_terms,'{}'::text[]),
         j.mapper_model,
         j.critic_model,
         'passed','passed',left(coalesce(x.reason,''),1000),
         j.id,j.freeze_receipt_id,a.analysis_body_clean_sha256,s.raw_ocr_sha256,
         encode(extensions.digest(convert_to(r.region_text,'UTF8'),'sha256'),'hex'),
         left(coalesce(x.grounding_model,''),200),
         x.grounding_decision,
         now()
  from jsonb_to_recordset(p_rows) as x(
    article_id uuid,
    grounding_decision text,
    shared_terms text[],
    reason text,
    grounding_model text
  )
  join public.formal_corpus_articles_v1 f on f.id=x.article_id
  join public.articles a on a.id=f.id
  join public.source_images s on s.id=j.evidence_source_image_id
  join lateral (
    select max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))) headline_sim,
           string_agg(b.block_text,E'\n\n' order by p.block_index) region_text
    from public.source_page_partition_proposals_v3 p
    join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
    where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id
  ) r on true;

  return jsonb_build_object('status','stored','job_id',j.id,'review_count',v_input_count,'weak_article_count',v_expected_weak);
end $$;

revoke execute on function public.renew_source_page_partition_job_lease_v3(uuid,uuid,integer) from public,anon,authenticated;
revoke execute on function public.replace_article_source_grounding_reviews_v3(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.renew_source_page_partition_job_lease_v3(uuid,uuid,integer) to service_role;
grant execute on function public.replace_article_source_grounding_reviews_v3(uuid,uuid,jsonb) to service_role;