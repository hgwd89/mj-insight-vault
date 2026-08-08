alter table public.formal_report_pass_runs_v6 add column if not exists input_fingerprint text;
alter table public.formal_report_pass_runs_v6 drop constraint if exists formal_report_pass_runs_v6_input_fingerprint_check;
alter table public.formal_report_pass_runs_v6 add constraint formal_report_pass_runs_v6_input_fingerprint_check check(input_fingerprint is null or input_fingerprint ~ '^[0-9a-f]{64}$');

create or replace function public.formal_report_writer_input_fingerprint_v6(p_job_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select encode(extensions.digest(convert_to(jsonb_build_array(j.analysis_run_id::text,j.theme_proof_receipt_id::text,j.user_query,j.candidate_set_fingerprint,j.census_identity_fingerprint,j.metrics_fingerprint,j.selection_fingerprint,j.evidence_fingerprint,j.selected_theme_count)::text,'UTF8'),'sha256'),'hex')
from public.formal_report_jobs_v6 j where j.id=p_job_id;
$$;

create or replace function public.formal_report_claim_set_fingerprint_v6(p_job_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select encode(extensions.digest(convert_to(coalesce(string_agg(jsonb_build_array(claim_index,claim_type,candidate_ids,claim_text_sha256,support_article_ids,counter_article_ids,coalesce(caveat,''))::text,'|' order by claim_index),''),'UTF8'),'sha256'),'hex')
from public.formal_report_claims_v6 where report_job_id=p_job_id;
$$;

create or replace function public.formal_report_critic_input_fingerprint_v6(p_job_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select encode(extensions.digest(convert_to(coalesce(public.formal_report_writer_input_fingerprint_v6(p_job_id),'')||E'\n--CLAIMS--\n'||coalesce(public.formal_report_claim_set_fingerprint_v6(p_job_id),''),'UTF8'),'sha256'),'hex');
$$;

create or replace function public.get_formal_report_job_input_v6(p_job_id uuid,p_lease_token uuid,p_pass_kind text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;v_input_fp text;begin
  if p_pass_kind not in ('writer','critic') then raise exception 'report_v6_pass_kind_invalid'; end if;
  select * into j from public.formal_report_jobs_v6 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'report_v6_lease_invalid'; end if;
  if not public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id)
     or j.census_identity_fingerprint<>public.theme_census_identity_fingerprint_v6(j.analysis_run_id)
     or j.metrics_fingerprint<>public.theme_metrics_fingerprint_v6(j.analysis_run_id)
     or j.selection_fingerprint<>public.theme_selection_fingerprint_v6(j.analysis_run_id)
     or j.evidence_fingerprint<>public.theme_evidence_fingerprint_v6(j.analysis_run_id) then raise exception 'report_v6_input_stale'; end if;
  if p_pass_kind='critic' and not exists(select 1 from public.formal_report_pass_runs_v6 where report_job_id=j.id and pass_kind='writer') then raise exception 'report_v6_writer_required_before_critic'; end if;
  v_input_fp:=case when p_pass_kind='writer' then public.formal_report_writer_input_fingerprint_v6(j.id) else public.formal_report_critic_input_fingerprint_v6(j.id) end;
  return jsonb_build_object(
    'report_job_id',j.id,'analysis_run_id',j.analysis_run_id,'pass_kind',p_pass_kind,'user_query',j.user_query,'input_fingerprint',v_input_fp,
    'proof',jsonb_build_object('candidate_set_fingerprint',j.candidate_set_fingerprint,'census_identity_fingerprint',j.census_identity_fingerprint,'metrics_fingerprint',j.metrics_fingerprint,'selection_fingerprint',j.selection_fingerprint,'evidence_fingerprint',j.evidence_fingerprint),
    'themes',(select jsonb_agg(jsonb_build_object('candidate_id',s.candidate_id,'theme_key',s.theme_key,'title',s.title,'definition',s.definition,'rank',s.selection_rank,'support_count',s.support_count,'counter_count',s.counter_count,'direct_consumer_support_count',s.direct_consumer_support_count,'support_page_count',s.support_page_count,'support_day_count',s.support_day_count,'support_share_pct',s.support_share_pct,'counter_share_pct',s.counter_share_pct) order by s.selection_rank) from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.selected_for_report),
    'evidence',(select jsonb_agg(jsonb_build_object('candidate_id',e.candidate_id,'theme_key',e.theme_key,'relation',e.relation,'rank',e.evidence_rank,'article_id',e.article_id,'headline',g.headline,'article_date',g.article_date,'subject',e.subject,'measurement',e.measurement,'confidence',e.confidence,'source_anchor',e.source_region_anchor,'source_block_index',e.source_block_index,'source_block_sha256',e.source_block_sha256,'source_block_text',(select x.block_text from public.article_source_blocks_v4(e.article_id) x where x.block_index=e.source_block_index limit 1)) order by e.theme_key,e.relation,e.evidence_rank) from public.theme_deterministic_evidence_v6 e join public.formal_source_grounded_articles_v4 g on g.article_id=e.article_id where e.analysis_run_id=j.analysis_run_id),
    'claims',case when p_pass_kind='critic' then (select coalesce(jsonb_agg(jsonb_build_object('claim_index',c.claim_index,'claim_type',c.claim_type,'candidate_ids',c.candidate_ids,'claim_text',c.claim_text,'claim_text_sha256',c.claim_text_sha256,'support_article_ids',c.support_article_ids,'counter_article_ids',c.counter_article_ids,'caveat',c.caveat) order by c.claim_index),'[]'::jsonb) from public.formal_report_claims_v6 c where c.report_job_id=j.id) else null end
  );
end $$;

create or replace function public.replace_formal_report_writer_v6(p_job_id uuid,p_lease_token uuid,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_claims jsonb)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;v_count integer;v_input_fp text;begin
  select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'report_v6_lease_invalid'; end if;
  if not public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id)
     or j.census_identity_fingerprint<>public.theme_census_identity_fingerprint_v6(j.analysis_run_id)
     or j.metrics_fingerprint<>public.theme_metrics_fingerprint_v6(j.analysis_run_id)
     or j.selection_fingerprint<>public.theme_selection_fingerprint_v6(j.analysis_run_id)
     or j.evidence_fingerprint<>public.theme_evidence_fingerprint_v6(j.analysis_run_id) then raise exception 'report_v6_upstream_stale'; end if;
  v_input_fp:=public.formal_report_writer_input_fingerprint_v6(j.id);
  if jsonb_typeof(p_claims)<>'array' or jsonb_array_length(p_claims)<1 or jsonb_array_length(p_claims)>80 then raise exception 'report_v6_claim_array_invalid'; end if;
  delete from public.formal_report_critic_rows_v6 where report_job_id=j.id;
  delete from public.formal_report_claims_v6 where report_job_id=j.id;
  delete from public.formal_report_pass_runs_v6 where report_job_id=j.id;
  insert into public.formal_report_claims_v6(report_job_id,claim_index,claim_type,candidate_ids,claim_text,claim_text_sha256,support_article_ids,counter_article_ids,caveat)
  select j.id,(x->>'claim_index')::integer,x->>'claim_type',array(select jsonb_array_elements_text(coalesce(x->'candidate_ids','[]'::jsonb))::uuid),x->>'claim_text',repeat('0',64),array(select jsonb_array_elements_text(coalesce(x->'support_article_ids','[]'::jsonb))::uuid),array(select jsonb_array_elements_text(coalesce(x->'counter_article_ids','[]'::jsonb))::uuid),nullif(x->>'caveat','') from jsonb_array_elements(p_claims) x;
  get diagnostics v_count=row_count;
  if v_count<>jsonb_array_length(p_claims) or (select count(distinct claim_index) from public.formal_report_claims_v6 where report_job_id=j.id)<>v_count then raise exception 'report_v6_claim_count_or_index_invalid'; end if;
  insert into public.formal_report_pass_runs_v6(report_job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,input_fingerprint)
  values(j.id,'writer',left(btrim(p_model),200),btrim(p_provider_response_id),p_prompt_sha256,p_response_sha256,v_input_fp);
  return jsonb_build_object('status','writer_stored','claim_count',v_count,'input_fingerprint',v_input_fp,'claims',(select jsonb_agg(jsonb_build_object('claim_id',id,'claim_index',claim_index,'claim_text_sha256',claim_text_sha256) order by claim_index) from public.formal_report_claims_v6 where report_job_id=j.id));
end $$;

create or replace function public.replace_formal_report_critic_v6(p_job_id uuid,p_lease_token uuid,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;w public.formal_report_pass_runs_v6%rowtype;v_expected integer;v_count integer;v_input_fp text;begin
  select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'report_v6_lease_invalid'; end if;
  if not public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id) then raise exception 'report_v6_upstream_stale'; end if;
  select * into w from public.formal_report_pass_runs_v6 where report_job_id=j.id and pass_kind='writer';
  if w.id is null or w.input_fingerprint<>public.formal_report_writer_input_fingerprint_v6(j.id) then raise exception 'report_v6_writer_receipt_stale'; end if;
  if w.model=btrim(p_model) or w.provider_response_id=btrim(p_provider_response_id) or w.prompt_sha256=p_prompt_sha256 then raise exception 'report_v6_critic_not_independent'; end if;
  v_input_fp:=public.formal_report_critic_input_fingerprint_v6(j.id);
  select count(*)::integer into v_expected from public.formal_report_claims_v6 where report_job_id=j.id;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<>v_expected then raise exception 'report_v6_critic_row_count_mismatch'; end if;
  delete from public.formal_report_critic_rows_v6 where report_job_id=j.id;
  delete from public.formal_report_pass_runs_v6 where report_job_id=j.id and pass_kind='critic';
  insert into public.formal_report_critic_rows_v6(report_job_id,claim_id,claim_text_sha256,verdict,evidence_sufficient,numeric_accuracy,causal_strength_ok,scope_ok,counterevidence_handled,notes)
  select j.id,c.id,c.claim_text_sha256,x->>'verdict',(x->>'evidence_sufficient')::boolean,(x->>'numeric_accuracy')::boolean,(x->>'causal_strength_ok')::boolean,(x->>'scope_ok')::boolean,(x->>'counterevidence_handled')::boolean,coalesce(x->>'notes','') from jsonb_array_elements(p_rows) x join public.formal_report_claims_v6 c on c.report_job_id=j.id and c.claim_index=(x->>'claim_index')::integer;
  get diagnostics v_count=row_count;
  if v_count<>v_expected then raise exception 'report_v6_critic_insert_count_mismatch'; end if;
  insert into public.formal_report_pass_runs_v6(report_job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,input_fingerprint)
  values(j.id,'critic',left(btrim(p_model),200),btrim(p_provider_response_id),p_prompt_sha256,p_response_sha256,v_input_fp);
  return jsonb_build_object('status','critic_stored','row_count',v_count,'input_fingerprint',v_input_fp);
end $$;

create or replace function public.formal_report_integrity_v6(p_job_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
with j as (select * from public.formal_report_jobs_v6 where id=p_job_id),passes as (
 select max(model) filter(where pass_kind='writer') wm,max(model) filter(where pass_kind='critic') cm,max(provider_response_id) filter(where pass_kind='writer') wr,max(provider_response_id) filter(where pass_kind='critic') cr,max(prompt_sha256) filter(where pass_kind='writer') wp,max(prompt_sha256) filter(where pass_kind='critic') cp,max(input_fingerprint) filter(where pass_kind='writer') wi,max(input_fingerprint) filter(where pass_kind='critic') ci,count(*) pc from public.formal_report_pass_runs_v6 where report_job_id=p_job_id
),coverage as (
 select count(*)::integer covered from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and s.candidate_id=any(c.candidate_ids) and c.claim_type in ('observed','inferred','implication'))
),counter_cov as (
 select count(*)::integer covered from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and s.counter_count>0 and exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and s.candidate_id=any(c.candidate_ids) and exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.candidate_id=s.candidate_id and e.relation='counter' and e.article_id=any(c.counter_article_ids)))
),counter_need as (select count(*)::integer needed from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and s.counter_count>0)
select exists(
 select 1 from j cross join passes p cross join coverage cv cross join counter_cov cc cross join counter_need cn
 where public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id) and public.theme_analysis_proof_integrity_v6(j.analysis_run_id)
   and j.candidate_set_fingerprint=(select candidate_set_fingerprint from public.theme_analysis_proof_receipts_v6 where id=j.theme_proof_receipt_id)
   and j.census_identity_fingerprint=public.theme_census_identity_fingerprint_v6(j.analysis_run_id) and j.metrics_fingerprint=public.theme_metrics_fingerprint_v6(j.analysis_run_id) and j.selection_fingerprint=public.theme_selection_fingerprint_v6(j.analysis_run_id) and j.evidence_fingerprint=public.theme_evidence_fingerprint_v6(j.analysis_run_id)
   and j.selected_theme_count=(select count(*) from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.selected_for_report)
   and p.pc=2 and p.wm<>p.cm and p.wr<>p.cr and p.wp<>p.cp
   and p.wi=public.formal_report_writer_input_fingerprint_v6(j.id) and p.ci=public.formal_report_critic_input_fingerprint_v6(j.id)
   and (select count(*) from public.formal_report_claims_v6 c where c.report_job_id=j.id)>0
   and (select count(*) from public.formal_report_critic_rows_v6 r where r.report_job_id=j.id)=(select count(*) from public.formal_report_claims_v6 c where c.report_job_id=j.id)
   and not exists(select 1 from public.formal_report_critic_rows_v6 r join public.formal_report_claims_v6 c on c.id=r.claim_id where r.report_job_id=j.id and (r.claim_text_sha256<>c.claim_text_sha256 or r.verdict<>'supported' or not r.evidence_sufficient or not r.numeric_accuracy or not r.causal_strength_ok or not r.scope_ok or not r.counterevidence_handled))
   and cv.covered=j.selected_theme_count and cc.covered=cn.needed
   and (j.selected_theme_count<2 or exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and c.claim_type='cross_theme_narrative' and cardinality(c.candidate_ids)>=2))
);
$$;

revoke execute on function public.formal_report_writer_input_fingerprint_v6(uuid),public.formal_report_claim_set_fingerprint_v6(uuid),public.formal_report_critic_input_fingerprint_v6(uuid),public.get_formal_report_job_input_v6(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.formal_report_writer_input_fingerprint_v6(uuid),public.formal_report_claim_set_fingerprint_v6(uuid),public.formal_report_critic_input_fingerprint_v6(uuid),public.get_formal_report_job_input_v6(uuid,uuid,text) to service_role;