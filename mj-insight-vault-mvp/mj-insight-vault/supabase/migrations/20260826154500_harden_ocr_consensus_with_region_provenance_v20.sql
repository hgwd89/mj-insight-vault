-- Fail closed on weak recovered-Inventory article-to-region provenance.
-- OCR glyph quality alone is insufficient: a perfectly transcribed wrong region must never become canonical.

create or replace function public.ocr_combined_region_quality_v20(
  p_partition_job_id uuid,
  p_article_id uuid
)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
  select case
    when g.region_quality_status = 'invalid' then 'invalid'
    when coalesce(p.provenance_quality_status,'low') = 'low' then 'low'
    when g.region_quality_status = 'low' then 'low'
    when coalesce(p.provenance_quality_status,'low') = 'review' then 'review'
    when g.region_quality_status = 'review' then 'review'
    when g.region_quality_status = 'strong'
     and p.provenance_quality_status = 'strong' then 'strong'
    else 'low'
  end
  from public.ocr_grounded_articles_for_partition_v1(p_partition_job_id) g
  left join public.ocr_region_provenance_quality_v19 p
    on p.article_id=g.article_id
   and p.partition_job_id=g.partition_job_id
  where g.article_id=p_article_id
  limit 1
$function$;

revoke all on function public.ocr_combined_region_quality_v20(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ocr_combined_region_quality_v20(uuid,uuid) to postgres,service_role;

create or replace function public.decide_ocr_consensus_article_v11(
  p_job_id uuid,
  p_lease_token uuid,
  p_article_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  e public.ocr_consensus_evidence_v11%rowtype;
  v_status text;
  v_reason text;
  v_selected text;
  v_text text;
  v_text_sha text;
  v_source_legacy uuid;
  v_region_quality text;
  v_partition_job_id uuid;
begin
  select * into j
  from public.ocr_consensus_jobs_v11
  where id=p_job_id
  for update;

  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'ocr_consensus_v11_lease_invalid';
  end if;

  if exists(select 1 from public.ocr_consensus_decisions_v11 where job_id=j.id and article_id=p_article_id) then
    return (
      select jsonb_build_object('status',decision_status,'article_id',article_id,'existing',true)
      from public.ocr_consensus_decisions_v11
      where job_id=j.id and article_id=p_article_id
    );
  end if;

  select * into e
  from public.ocr_consensus_evidence_v11
  where job_id=j.id and article_id=p_article_id;

  if not found or e.sol_text is null then
    return jsonb_build_object('status','sol_required','article_id',p_article_id);
  end if;

  select src.partition_job_id into v_partition_job_id
  from public.ocr_verification_page_jobs_v2 src
  where src.id=j.source_job_id;

  if v_partition_job_id is null then
    raise exception 'ocr_consensus_v20_partition_missing';
  end if;

  select public.ocr_combined_region_quality_v20(v_partition_job_id,p_article_id)
    into v_region_quality;

  if v_region_quality is null then
    raise exception 'ocr_consensus_v20_region_quality_missing';
  end if;

  -- Provenance-low/invalid regions can never become canonical, even when two OCR models agree.
  -- Do not spend a Terra call on a region whose article mapping is already untrustworthy.
  if v_region_quality in ('low','invalid') then
    v_status := 'needs_review';
    v_selected := null;
    v_text := null;
    v_text_sha := null;
    v_reason := format(
      'provenance-aware region gate failed before Terra: combined_region=%s sol_conf=%s google_sol_sim=%s google_sol_numeric=%s',
      v_region_quality,
      e.sol_confidence,
      round(coalesce(e.google_sol_similarity,0)::numeric,4),
      coalesce(e.google_sol_numeric_equal,false)
    );
  elsif v_region_quality='strong'
     and e.sol_confidence>=0.95
     and e.sol_output_contract_status='passed'
     and e.sol_proper_noun_status<>'failed'
     and coalesce(e.google_sol_similarity,0)>=0.97
     and e.google_sol_numeric_equal is true then
    v_status := 'passed_single';
    v_selected := 'sol';
    v_text := e.sol_text;
    v_text_sha := e.sol_text_sha256;
    v_reason := format(
      'strict single-pass independent consensus: combined_region=%s sol_conf=%s google_sol_sim=%s numeric_equal=true',
      v_region_quality,e.sol_confidence,round(e.google_sol_similarity::numeric,4)
    );
  elsif e.terra_text is null then
    return jsonb_build_object(
      'status','terra_required',
      'article_id',p_article_id,
      'region_quality_status',v_region_quality,
      'sol_confidence',e.sol_confidence,
      'google_sol_similarity',e.google_sol_similarity,
      'google_sol_numeric_equal',e.google_sol_numeric_equal
    );
  elsif v_region_quality in ('strong','review')
     and e.sol_confidence>=0.88
     and e.terra_confidence>=0.88
     and e.sol_output_contract_status='passed'
     and e.terra_output_contract_status='passed'
     and e.sol_proper_noun_status<>'failed'
     and e.terra_proper_noun_status<>'failed'
     and coalesce(e.sol_terra_similarity,0)>=0.96
     and e.sol_terra_numeric_equal is true
     and e.sol_terra_proper_noun_agreement is true then
    v_status := 'passed_two_model';
    v_selected := 'sol';
    v_text := e.sol_text;
    v_text_sha := e.sol_text_sha256;
    v_reason := format(
      'provenance-aware two-model consensus: combined_region=%s sol_conf=%s terra_conf=%s sol_terra_sim=%s numeric_equal=true proper_nouns_agree=true',
      v_region_quality,e.sol_confidence,e.terra_confidence,round(e.sol_terra_similarity::numeric,4)
    );
  else
    v_status := 'needs_review';
    v_selected := null;
    v_text := null;
    v_text_sha := null;
    v_reason := format(
      'independent consensus failed: combined_region=%s sol_conf=%s terra_conf=%s google_sol_sim=%s google_terra_sim=%s sol_terra_sim=%s google_sol_numeric=%s google_terra_numeric=%s sol_terra_numeric=%s proper_nouns_agree=%s sol_contract=%s terra_contract=%s',
      v_region_quality,e.sol_confidence,e.terra_confidence,
      round(coalesce(e.google_sol_similarity,0)::numeric,4),
      round(coalesce(e.google_terra_similarity,0)::numeric,4),
      round(coalesce(e.sol_terra_similarity,0)::numeric,4),
      coalesce(e.google_sol_numeric_equal,false),
      coalesce(e.google_terra_numeric_equal,false),
      coalesce(e.sol_terra_numeric_equal,false),
      coalesce(e.sol_terra_proper_noun_agreement,false),
      e.sol_output_contract_status,e.terra_output_contract_status
    );
  end if;

  insert into public.ocr_consensus_decisions_v11(
    job_id,article_id,decision_status,selected_source,canonical_text,canonical_text_sha256,
    google_sol_similarity,google_terra_similarity,sol_terra_similarity,
    google_sol_numeric_equal,google_terra_numeric_equal,sol_terra_numeric_equal,
    sol_terra_proper_noun_agreement,decision_reason
  ) values (
    j.id,p_article_id,v_status,v_selected,v_text,v_text_sha,
    e.google_sol_similarity,e.google_terra_similarity,e.sol_terra_similarity,
    e.google_sol_numeric_equal,e.google_terra_numeric_equal,e.sol_terra_numeric_equal,
    e.sol_terra_proper_noun_agreement,v_reason
  );

  if v_status like 'passed_%' then
    v_source_legacy := j.source_job_id;
    insert into public.article_ocr_verifications_v11(
      article_id,source_consensus_job_id,source_legacy_job_id,canonical_text,canonical_text_sha256,
      selected_source,google_crop_text_sha256,sol_text_sha256,terra_text_sha256,quality_reason
    ) values (
      p_article_id,j.id,v_source_legacy,v_text,v_text_sha,v_selected,
      e.google_text_sha256,e.sol_text_sha256,e.terra_text_sha256,v_reason
    )
    on conflict(article_id) do update set
      source_consensus_job_id=excluded.source_consensus_job_id,
      source_legacy_job_id=excluded.source_legacy_job_id,
      canonical_text=excluded.canonical_text,
      canonical_text_sha256=excluded.canonical_text_sha256,
      selected_source=excluded.selected_source,
      google_crop_text_sha256=excluded.google_crop_text_sha256,
      sol_text_sha256=excluded.sol_text_sha256,
      terra_text_sha256=excluded.terra_text_sha256,
      quality_reason=excluded.quality_reason,
      verified_at=now(),
      updated_at=now();
  end if;

  return jsonb_build_object(
    'status',v_status,
    'article_id',p_article_id,
    'combined_region_quality_status',v_region_quality,
    'selected_source',v_selected
  );
end
$function$;

revoke all on function public.decide_ocr_consensus_article_v11(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.decide_ocr_consensus_article_v11(uuid,uuid,uuid) to postgres,service_role;
