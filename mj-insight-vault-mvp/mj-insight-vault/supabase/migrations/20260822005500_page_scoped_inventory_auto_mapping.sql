create or replace function public.resolve_inventory_mapping_auto_v3(
  p_job_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
set statement_timeout to '90s'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_groups integer;
  v_formal_articles integer;
  v_resolved integer;
  v_total_resolved integer;
begin
  select *
    into j
  from public.source_page_article_inventory_jobs_v1
  where id = p_job_id
  for update;

  if not found
     or j.status <> 'running'
     or j.lease_token is distinct from p_lease_token
     or j.lease_expires_at < now() then
    raise exception 'inventory_v3_auto_map_lease_invalid';
  end if;

  if public.inventory_consensus_source_v3(j.id) is null then
    raise exception 'inventory_v3_consensus_unresolved';
  end if;

  select count(*)::integer
    into v_groups
  from public.source_page_article_inventory_consensus_groups_v3
  where job_id = j.id;

  with arts as (
    select distinct
      ar.id,
      ar.headline,
      ar.analysis_body_clean
    from public.source_page_capture_map_v1 cm
    join public.articles ar
      on ar.source_image_id = cm.source_image_id
    join public.source_images s
      on s.id = ar.source_image_id
    join public.source_publication_date_effective_v1 d
      on d.source_image_id = ar.source_image_id
    where cm.page_identity_source_image_id = j.page_identity_source_image_id
      and (ar.status is null or ar.status <> all(array['deleted'::text,'excluded'::text,'rejected'::text]))
      and coalesce(ar.article_type, ''::text) = 'article'
      and coalesce(btrim(ar.ocr_text), ''::text) <> ''
      and ar.source_image_id is not null
      and s.duplicate_of_source_image_id is null
      and ar.provenance_status = any(array['traceable'::text,'legacy_traceable'::text])
      and coalesce(s.raw_ocr_sha256, ''::text) ~ '^[0-9a-f]{64}$'::text
      and ar.source_ocr_sha256 = s.raw_ocr_sha256
      and ar.analysis_text_sha256 = encode(extensions.digest(convert_to(coalesce(ar.ocr_text, ''), 'UTF8'), 'sha256'), 'hex')
      and ar.analysis_body_clean_version = 'clean_article_analysis_body_v1'
      and ar.analysis_body_clean_sha256 = encode(extensions.digest(convert_to(coalesce(ar.analysis_body_clean, ''), 'UTF8'), 'sha256'), 'hex')
      and coalesce(ar.analysis_body_clean, ''::text) <> ''
      and ar.analysis_text_origin <> 'pending'
      and ar.duplicate_of_article_id is null
      and ar.article_date_normalized is not null
      and ar.article_date_normalization_version = 'normalize_mj_article_date_v1'
      and d.publication_date_quality_status = 'passed'
      and d.publication_date = ar.article_date_normalized
      and not ar.hard_advertisement_flag
      and ar.content_role_version = 'hard_advertisement_v1'
  )
  select count(*)::integer
    into v_formal_articles
  from arts;

  if v_formal_articles <> j.existing_article_count then
    raise exception 'inventory_v3_auto_map_formal_page_article_count_mismatch:%/%',
      v_formal_articles, j.existing_article_count;
  end if;

  delete from public.source_page_article_inventory_mappings_v2
  where job_id = j.id
    and mapping_method = 'auto_reciprocal_headline';

  with arts as (
    select distinct
      ar.id,
      ar.headline,
      ar.analysis_body_clean
    from public.source_page_capture_map_v1 cm
    join public.articles ar
      on ar.source_image_id = cm.source_image_id
    join public.source_images s
      on s.id = ar.source_image_id
    join public.source_publication_date_effective_v1 d
      on d.source_image_id = ar.source_image_id
    where cm.page_identity_source_image_id = j.page_identity_source_image_id
      and (ar.status is null or ar.status <> all(array['deleted'::text,'excluded'::text,'rejected'::text]))
      and coalesce(ar.article_type, ''::text) = 'article'
      and coalesce(btrim(ar.ocr_text), ''::text) <> ''
      and ar.source_image_id is not null
      and s.duplicate_of_source_image_id is null
      and ar.provenance_status = any(array['traceable'::text,'legacy_traceable'::text])
      and coalesce(s.raw_ocr_sha256, ''::text) ~ '^[0-9a-f]{64}$'::text
      and ar.source_ocr_sha256 = s.raw_ocr_sha256
      and ar.analysis_text_sha256 = encode(extensions.digest(convert_to(coalesce(ar.ocr_text, ''), 'UTF8'), 'sha256'), 'hex')
      and ar.analysis_body_clean_version = 'clean_article_analysis_body_v1'
      and ar.analysis_body_clean_sha256 = encode(extensions.digest(convert_to(coalesce(ar.analysis_body_clean, ''), 'UTF8'), 'sha256'), 'hex')
      and coalesce(ar.analysis_body_clean, ''::text) <> ''
      and ar.analysis_text_origin <> 'pending'
      and ar.duplicate_of_article_id is null
      and ar.article_date_normalized is not null
      and ar.article_date_normalization_version = 'normalize_mj_article_date_v1'
      and d.publication_date_quality_status = 'passed'
      and d.publication_date = ar.article_date_normalized
      and not ar.hard_advertisement_flag
      and ar.content_role_version = 'hard_advertisement_v1'
  ),
  scores as (
    select
      g.group_fingerprint,
      a.id as article_id,
      greatest(
        extensions.similarity(lower(coalesce(a.headline, '')), lower(coalesce(g.headline_anchor, ''))),
        extensions.similarity(lower(coalesce(a.headline, '')), lower(left(coalesce(g.group_text, ''), 240)))
      )::numeric as headline_score,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(g.group_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(a.analysis_body_clean, ''), 4000))
      )::numeric as body_score
    from public.source_page_article_inventory_consensus_groups_v3 g
    cross join arts a
    where g.job_id = j.id
  ),
  ranked as (
    select
      s.*,
      row_number() over(partition by group_fingerprint order by body_score desc, headline_score desc, article_id) as body_group_rank,
      row_number() over(partition by article_id order by body_score desc, headline_score desc, group_fingerprint) as body_article_rank,
      body_score - lead(body_score) over(partition by group_fingerprint order by body_score desc, headline_score desc, article_id) as body_group_margin,
      row_number() over(partition by group_fingerprint order by headline_score desc, body_score desc, article_id) as headline_group_rank,
      row_number() over(partition by article_id order by headline_score desc, body_score desc, group_fingerprint) as headline_article_rank,
      headline_score - lead(headline_score) over(partition by group_fingerprint order by headline_score desc, body_score desc, article_id) as headline_group_margin
    from scores s
  ),
  body_primary as (
    select
      group_fingerprint,
      article_id,
      greatest(body_score, headline_score) as mapping_score,
      coalesce(body_group_margin, body_score) as mapping_margin
    from ranked
    where body_group_rank = 1
      and body_article_rank = 1
      and body_score >= 0.05
      and coalesce(body_group_margin, body_score) >= 0.01
  ),
  headline_primary as (
    select
      r.group_fingerprint,
      r.article_id,
      greatest(r.body_score, r.headline_score) as mapping_score,
      least(coalesce(r.headline_group_margin, r.headline_score), coalesce(r.body_group_margin, r.body_score)) as mapping_margin
    from ranked r
    where not exists (select 1 from body_primary p where p.group_fingerprint = r.group_fingerprint)
      and not exists (select 1 from body_primary p where p.article_id = r.article_id)
      and r.headline_group_rank = 1
      and r.headline_article_rank = 1
      and r.headline_score >= 0.18
      and coalesce(r.headline_group_margin, r.headline_score) >= 0.03
      and (r.body_score >= 0.02 or v_groups = 1)
  ),
  primary_selected as (
    select * from body_primary
    union all
    select * from headline_primary
  ),
  remaining as (
    select r.*
    from ranked r
    where not exists (select 1 from primary_selected p where p.group_fingerprint = r.group_fingerprint)
      and not exists (select 1 from primary_selected p where p.article_id = r.article_id)
  ),
  residual_ranked as (
    select
      r.*,
      row_number() over(partition by group_fingerprint order by body_score desc, headline_score desc, article_id) as remaining_group_rank,
      row_number() over(partition by article_id order by body_score desc, headline_score desc, group_fingerprint) as remaining_article_rank,
      body_score - lead(body_score) over(partition by group_fingerprint order by body_score desc, headline_score desc, article_id) as remaining_body_margin
    from remaining r
  ),
  residual as (
    select
      group_fingerprint,
      article_id,
      greatest(body_score, headline_score) as mapping_score,
      coalesce(remaining_body_margin, body_score) as mapping_margin
    from residual_ranked
    where remaining_group_rank = 1
      and remaining_article_rank = 1
      and (body_score >= 0.05 or headline_score >= 0.18)
  ),
  selected as (
    select * from primary_selected
    union all
    select * from residual
  )
  insert into public.source_page_article_inventory_mappings_v2(
    job_id,
    group_fingerprint,
    article_id,
    mapping_method,
    mapping_score,
    mapping_margin
  )
  select
    j.id,
    s.group_fingerprint,
    s.article_id,
    'auto_reciprocal_headline',
    s.mapping_score,
    s.mapping_margin
  from selected s
  on conflict(job_id, group_fingerprint) do nothing;

  get diagnostics v_resolved = row_count;

  select count(*)::integer
    into v_total_resolved
  from public.source_page_article_inventory_mappings_v2
  where job_id = j.id;

  return jsonb_build_object(
    'status', case when v_total_resolved = v_groups then 'resolved' else 'partial' end,
    'group_count', v_groups,
    'formal_page_article_count', v_formal_articles,
    'auto_resolved', v_resolved,
    'total_resolved', v_total_resolved,
    'unresolved', v_groups - v_total_resolved,
    'auto_mapping_contract', 'page_scoped_body_first_reciprocal_v2'
  );
end
$function$;
