create or replace function public.complete_article_classification_job_v2(
  p_job_id uuid,
  p_lease_token uuid,
  p_profile jsonb,
  p_memberships jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_job public.article_classification_jobs%rowtype;
  v_supplied_primary text := btrim(coalesce(p_profile->>'primary_category',''));
  v_primary text := v_supplied_primary;
  v_secondary text[] := '{}'::text[];
  v_confidence numeric;
  v_member jsonb;
  v_category text;
  v_member_confidence numeric;
  v_member_score numeric;
  v_membership_count integer := 0;
  v_primary_present boolean := false;
  v_normalized boolean := false;
  v_normalized_profile jsonb;
begin
  select * into v_job
  from public.article_classification_jobs j
  where j.id=p_job_id
    and j.status='running'
    and j.lease_token=p_lease_token
    and j.lease_expires_at>now()
  for update;

  if not found then
    raise exception using errcode='P0002',message='classification_job_lease_lost';
  end if;
  if not exists(select 1 from public.formal_corpus_articles_v1 a where a.id=v_job.article_id) then
    raise exception using errcode='23514',message='classification_article_not_formal';
  end if;
  if jsonb_typeof(p_profile)<>'object' then
    raise exception using errcode='22023',message='classification_profile_required';
  end if;
  if jsonb_typeof(p_memberships)<>'array' or jsonb_array_length(p_memberships)=0 then
    raise exception using errcode='22023',message='classification_memberships_required';
  end if;

  begin
    v_confidence := (p_profile->>'confidence')::numeric;
  exception when others then
    raise exception using errcode='22023',message='classification_confidence_invalid';
  end;
  if v_confidence<0 or v_confidence>1 then
    raise exception using errcode='22023',message='classification_confidence_out_of_range';
  end if;

  create temporary table if not exists pg_temp.validated_memberships(
    category_id text primary key,
    score numeric not null,
    confidence numeric not null,
    match_terms text[] not null,
    reason text
  ) on commit drop;
  truncate pg_temp.validated_memberships;

  for v_member in select value from jsonb_array_elements(p_memberships) loop
    if jsonb_typeof(v_member)<>'object' then continue; end if;
    v_category := btrim(coalesce(v_member->>'category_id',''));
    if v_category='' or not exists(
      select 1 from public.analysis_categories c
      where c.id=v_category and c.is_active=true
    ) then
      raise exception using errcode='22023',message='classification_category_invalid',detail=v_category;
    end if;
    begin
      v_member_confidence := (v_member->>'confidence')::numeric;
    exception when others then
      raise exception using errcode='22023',message='classification_membership_confidence_invalid';
    end;
    begin
      v_member_score := coalesce(nullif(v_member->>'score','')::numeric,v_member_confidence);
    exception when others then
      v_member_score := v_member_confidence;
    end;
    if v_member_confidence<0 or v_member_confidence>1 or v_member_score<0 or v_member_score>1 then
      raise exception using errcode='22023',message='classification_membership_score_out_of_range';
    end if;
    insert into pg_temp.validated_memberships(category_id,score,confidence,match_terms,reason)
    values(
      v_category,
      v_member_score,
      v_member_confidence,
      array(select value from jsonb_array_elements_text(
        case when jsonb_typeof(v_member->'match_terms')='array' then v_member->'match_terms' else '[]'::jsonb end
      ) limit 12),
      nullif(btrim(coalesce(v_member->>'reason','')),'')
    )
    on conflict(category_id) do update set
      score=greatest(pg_temp.validated_memberships.score,excluded.score),
      confidence=greatest(pg_temp.validated_memberships.confidence,excluded.confidence),
      match_terms=excluded.match_terms,
      reason=excluded.reason;
  end loop;

  select count(*),bool_or(category_id=v_primary)
  into v_membership_count,v_primary_present
  from pg_temp.validated_memberships;

  if v_membership_count=0 then
    raise exception using errcode='22023',message='classification_no_valid_memberships';
  end if;
  if v_membership_count>4 then
    raise exception using errcode='22023',message='classification_too_many_memberships';
  end if;

  if v_primary='' or not coalesce(v_primary_present,false) then
    select category_id into v_primary
    from pg_temp.validated_memberships
    order by score desc, confidence desc, category_id
    limit 1;
    v_normalized := true;
  end if;

  select coalesce(array_agg(category_id order by score desc,confidence desc,category_id), '{}'::text[])
  into v_secondary
  from (
    select category_id,score,confidence
    from pg_temp.validated_memberships
    where category_id<>v_primary
    order by score desc,confidence desc,category_id
    limit 3
  ) s;

  v_normalized_profile := p_profile || jsonb_build_object(
    'primary_category',v_primary,
    'secondary_categories',to_jsonb(v_secondary),
    'classifier_version','article_category_profile_v2',
    'model_used',v_job.model,
    'classified_at',now(),
    'normalization',jsonb_build_object(
      'supplied_primary_category',v_supplied_primary,
      'primary_was_normalized',v_normalized,
      'normalization_rule',case when v_normalized then 'highest_evidence_membership' else 'none' end
    )
  );

  insert into public.article_profiles(
    article_id,profile_model,primary_category,secondary_categories,
    consumer_scene,market_signal,product_type,consumer_need,
    confidence,reason,profile_json,updated_at
  ) values(
    v_job.article_id,'article_category_profile_v2',v_primary,v_secondary,
    nullif(btrim(coalesce(p_profile->>'consumer_scene','')),''),
    nullif(btrim(coalesce(p_profile->>'market_signal','')),''),
    nullif(btrim(coalesce(p_profile->>'product_type','')),''),
    nullif(btrim(coalesce(p_profile->>'consumer_need','')),''),
    v_confidence,
    nullif(btrim(coalesce(p_profile->>'reason','')),''),
    v_normalized_profile,
    now()
  )
  on conflict(article_id) do update set
    profile_model=excluded.profile_model,
    primary_category=excluded.primary_category,
    secondary_categories=excluded.secondary_categories,
    consumer_scene=excluded.consumer_scene,
    market_signal=excluded.market_signal,
    product_type=excluded.product_type,
    consumer_need=excluded.consumer_need,
    confidence=excluded.confidence,
    reason=excluded.reason,
    profile_json=excluded.profile_json,
    updated_at=now();

  delete from public.article_category_memberships where article_id=v_job.article_id;
  insert into public.article_category_memberships(
    article_id,category_id,score,confidence,source,match_terms,reason,updated_at
  )
  select v_job.article_id,category_id,score,confidence,'article_category_profile_v2',match_terms,reason,now()
  from pg_temp.validated_memberships;

  update public.article_classification_jobs
  set status='completed',
      result_json=jsonb_build_object('profile',v_normalized_profile,'memberships',p_memberships),
      error_message=null,
      lease_token=null,
      lease_expires_at=null,
      heartbeat_at=now(),
      updated_at=now(),
      finished_at=now()
  where id=v_job.id;

  return jsonb_build_object(
    'job_id',v_job.id,
    'article_id',v_job.article_id,
    'primary_category',v_primary,
    'supplied_primary_category',v_supplied_primary,
    'primary_was_normalized',v_normalized,
    'membership_count',v_membership_count,
    'status','completed'
  );
end;
$function$;