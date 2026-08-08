create or replace function public.article_source_blocks_v4(p_article_id uuid)
returns table(block_index integer,block_sha256 text,block_text text,x_min integer,y_min integer,x_max integer,y_max integer)
language sql stable security definer
set search_path=pg_catalog,public
as $$
select b.block_index,b.source_block_sha256,b.block_text,b.x_min,b.y_min,b.x_max,b.y_max
from public.formal_source_grounded_article_blocks_v4 b
where b.article_id=p_article_id
order by b.block_index;
$$;

create or replace function public.get_theme_census_batch_input_v5(p_batch_id uuid,p_lease_token uuid,p_pass_kind text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare b public.theme_census_batches_v4%rowtype;a public.theme_analysis_runs_v4%rowtype;v_fp text;begin
  if p_pass_kind not in ('mapper','critic') then raise exception 'census_v5_pass_kind_invalid'; end if;
  select * into b from public.theme_census_batches_v4 where id=p_batch_id;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'census_v5_lease_invalid'; end if;
  select * into a from public.theme_analysis_runs_v4 where id=b.analysis_run_id;
  if not public.full_corpus_run_integrity_v5(a.scan_run_id) or a.candidate_set_fingerprint<>public.theme_candidate_set_fingerprint_v4(a.id) or a.candidate_set_fingerprint<>b.candidate_set_fingerprint then raise exception 'census_v5_input_stale'; end if;
  v_fp:=public.theme_census_batch_input_fingerprint_v5(b.id);
  return jsonb_build_object(
    'batch_id',b.id,'analysis_run_id',a.id,'batch_index',b.batch_index,'pass_kind',p_pass_kind,
    'candidate_set_fingerprint',a.candidate_set_fingerprint,'batch_input_fingerprint',v_fp,
    'candidates',(select jsonb_agg(jsonb_build_object('candidate_id',c.id,'theme_key',c.theme_key,'title',c.title,'definition',c.definition,'inclusion_rule',c.inclusion_rule,'exclusion_rule',c.exclusion_rule) order by c.theme_key) from public.theme_candidates_v4 c where c.analysis_run_id=a.id),
    'articles',(select jsonb_agg(jsonb_build_object(
       'article_id',g.article_id,'headline',g.headline,'article_date',g.article_date,'source_region_id',g.source_region_id,'source_region_sha256',g.source_region_sha256,
       'blocks',(select jsonb_agg(jsonb_build_object('block_index',x.block_index,'block_sha256',x.block_sha256,'text',x.block_text,'x_min',x.x_min,'y_min',x.y_min,'x_max',x.x_max,'y_max',x.y_max) order by x.block_index) from public.article_source_blocks_v4(g.article_id) x)
     ) order by g.article_id)
     from unnest(b.article_ids) u(article_id) join public.formal_source_grounded_articles_v4 g on g.article_id=u.article_id)
  );
end $$;

revoke execute on function public.article_source_blocks_v4(uuid),public.get_theme_census_batch_input_v5(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.article_source_blocks_v4(uuid),public.get_theme_census_batch_input_v5(uuid,uuid,text) to service_role;