create or replace function public.validate_formal_report_claim_v6()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,extensions
as $$
declare j public.formal_report_jobs_v6%rowtype;v_pages integer;v_n integer;v_candidate uuid;begin
  select * into j from public.formal_report_jobs_v6 where id=new.report_job_id;
  if not found or j.status<>'running' then raise exception 'report_v6_job_not_running'; end if;
  new.claim_text:=btrim(new.claim_text);
  new.claim_text_sha256:=encode(extensions.digest(convert_to(new.claim_text,'UTF8'),'sha256'),'hex');
  select count(distinct x)::integer into v_n from unnest(new.candidate_ids) x;if v_n<>cardinality(new.candidate_ids) then raise exception 'report_v6_duplicate_candidate_ids'; end if;
  select count(distinct x)::integer into v_n from unnest(new.support_article_ids) x;if v_n<>cardinality(new.support_article_ids) then raise exception 'report_v6_duplicate_support_ids'; end if;
  select count(distinct x)::integer into v_n from unnest(new.counter_article_ids) x;if v_n<>cardinality(new.counter_article_ids) then raise exception 'report_v6_duplicate_counter_ids'; end if;
  if exists(select 1 from unnest(new.support_article_ids) s join unnest(new.counter_article_ids) c on c=s) then raise exception 'report_v6_support_counter_overlap'; end if;
  if new.claim_type in ('observed','inferred','implication','limitation') and cardinality(new.candidate_ids)<1 then raise exception 'report_v6_candidate_required'; end if;
  if new.claim_type='cross_theme_narrative' and cardinality(new.candidate_ids)<2 then raise exception 'report_v6_cross_theme_requires_two_candidates'; end if;
  if exists(select 1 from unnest(new.candidate_ids) x where not exists(select 1 from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.candidate_id=x and s.selected_for_report)) then raise exception 'report_v6_unselected_candidate'; end if;
  if exists(select 1 from unnest(new.support_article_ids) x where not exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.article_id=x and e.relation='support' and e.candidate_id=any(new.candidate_ids))) then raise exception 'report_v6_support_not_deterministic_evidence'; end if;
  if exists(select 1 from unnest(new.counter_article_ids) x where not exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.article_id=x and e.relation='counter' and e.candidate_id=any(new.candidate_ids))) then raise exception 'report_v6_counter_not_deterministic_evidence'; end if;
  if new.claim_type='observed' and cardinality(new.support_article_ids)<1 then raise exception 'report_v6_observed_support_required'; end if;
  if new.claim_type in ('inferred','implication','cross_theme_narrative') then
    if cardinality(new.support_article_ids)<2 then raise exception 'report_v6_multi_evidence_required'; end if;
    select count(distinct g.page_identity_source_image_id)::integer into v_pages from unnest(new.support_article_ids) x join public.formal_source_grounded_articles_v4 g on g.article_id=x;
    if v_pages<2 then raise exception 'report_v6_multi_page_support_required'; end if;
  end if;
  if cardinality(new.candidate_ids)>1 and new.claim_type in ('observed','inferred','implication','cross_theme_narrative') then
    foreach v_candidate in array new.candidate_ids loop
      if not exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.candidate_id=v_candidate and e.relation='support' and e.article_id=any(new.support_article_ids)) then raise exception 'report_v6_each_candidate_requires_support'; end if;
    end loop;
  end if;
  if new.claim_type='limitation' and length(btrim(coalesce(new.caveat,'')))<8 then raise exception 'report_v6_limitation_caveat_required'; end if;
  return new;
end $$;

create or replace function public.formal_report_integrity_v6(p_job_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
with j as (select * from public.formal_report_jobs_v6 where id=p_job_id),passes as (
 select max(model) filter(where pass_kind='writer') wm,max(model) filter(where pass_kind='critic') cm,max(provider_response_id) filter(where pass_kind='writer') wr,max(provider_response_id) filter(where pass_kind='critic') cr,max(prompt_sha256) filter(where pass_kind='writer') wp,max(prompt_sha256) filter(where pass_kind='critic') cp,count(*) pc from public.formal_report_pass_runs_v6 where report_job_id=p_job_id
),coverage as (
 select count(*)::integer covered from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and s.candidate_id=any(c.candidate_ids) and c.claim_type in ('observed','inferred','implication'))
),counter_cov as (
 select count(*)::integer covered from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and s.counter_count>0 and exists(
   select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and s.candidate_id=any(c.candidate_ids)
   and exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.candidate_id=s.candidate_id and e.relation='counter' and e.article_id=any(c.counter_article_ids))
 )
),counter_need as (select count(*)::integer needed from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and s.counter_count>0)
select exists(
 select 1 from j cross join passes p cross join coverage cv cross join counter_cov cc cross join counter_need cn
 where public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id)
   and public.theme_analysis_proof_integrity_v6(j.analysis_run_id)
   and j.candidate_set_fingerprint=(select candidate_set_fingerprint from public.theme_analysis_proof_receipts_v6 where id=j.theme_proof_receipt_id)
   and j.census_identity_fingerprint=public.theme_census_identity_fingerprint_v6(j.analysis_run_id)
   and j.metrics_fingerprint=public.theme_metrics_fingerprint_v6(j.analysis_run_id)
   and j.selection_fingerprint=public.theme_selection_fingerprint_v6(j.analysis_run_id)
   and j.evidence_fingerprint=public.theme_evidence_fingerprint_v6(j.analysis_run_id)
   and j.selected_theme_count=(select count(*) from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.selected_for_report)
   and p.pc=2 and p.wm<>p.cm and p.wr<>p.cr and p.wp<>p.cp
   and (select count(*) from public.formal_report_claims_v6 c where c.report_job_id=j.id)>0
   and (select count(*) from public.formal_report_critic_rows_v6 r where r.report_job_id=j.id)=(select count(*) from public.formal_report_claims_v6 c where c.report_job_id=j.id)
   and not exists(select 1 from public.formal_report_critic_rows_v6 r join public.formal_report_claims_v6 c on c.id=r.claim_id where r.report_job_id=j.id and (r.claim_text_sha256<>c.claim_text_sha256 or r.verdict<>'supported' or not r.evidence_sufficient or not r.numeric_accuracy or not r.causal_strength_ok or not r.scope_ok or not r.counterevidence_handled))
   and cv.covered=j.selected_theme_count and cc.covered=cn.needed
   and (j.selected_theme_count<2 or exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and c.claim_type='cross_theme_narrative' and cardinality(c.candidate_ids)>=2))
);
$$;

create or replace function public.formal_report_related_article_ids_v6(p_job_id uuid)
returns uuid[]
language sql stable security definer
set search_path=pg_catalog,public
as $$
select coalesce(array_agg(x order by x),'{}'::uuid[]) from (
 select distinct unnest(c.support_article_ids) x from public.formal_report_claims_v6 c where c.report_job_id=p_job_id
 union
 select distinct unnest(c.counter_article_ids) x from public.formal_report_claims_v6 c where c.report_job_id=p_job_id
) s;
$$;

create or replace function public.render_formal_report_text_v6(p_job_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public
as $$
with j as (select * from public.formal_report_jobs_v6 where id=p_job_id),
crossn as (
 select coalesce(string_agg('- '||claim_text,E'\n' order by claim_index),'（該当なし）') s from public.formal_report_claims_v6 where report_job_id=p_job_id and claim_type='cross_theme_narrative'
), themes as (
 select coalesce(string_agg(
   '### '||s.selection_rank||'. '||s.title||E'\n'||
   '支持 '||s.support_count||'件 / 直接生活者根拠 '||s.direct_consumer_support_count||'件 / 紙面 '||s.support_page_count||' / 日付 '||s.support_day_count||' / 反証 '||s.counter_count||E'件\n'||
   coalesce((select string_agg('- '||c.claim_text,E'\n' order by c.claim_index) from public.formal_report_claims_v6 c where c.report_job_id=p_job_id and s.candidate_id=any(c.candidate_ids) and c.claim_type in ('observed','inferred')),'（主張なし）'),
   E'\n\n' order by s.selection_rank),'（主要テーマなし）') s
 from j join public.theme_major_selection_v6 s on s.analysis_run_id=j.analysis_run_id and s.selected_for_report
), limits as (
 select coalesce(string_agg('- '||claim_text||case when coalesce(btrim(caveat),'')<>'' then ' — '||caveat else '' end,E'\n' order by claim_index),'（追加制約なし）') s from public.formal_report_claims_v6 where report_job_id=p_job_id and claim_type='limitation'
), implications as (
 select coalesce(string_agg('- '||claim_text,E'\n' order by claim_index),'（該当なし）') s from public.formal_report_claims_v6 where report_job_id=p_job_id and claim_type='implication'
), hypotheses as (
 select coalesce(string_agg('- '||claim_text,E'\n' order by claim_index),'（該当なし）') s from public.formal_report_claims_v6 where report_job_id=p_job_id and claim_type='hypothesis'
), research as (
 select coalesce(string_agg('- '||claim_text,E'\n' order by claim_index),'（該当なし）') s from public.formal_report_claims_v6 where report_job_id=p_job_id and claim_type='research_question'
), evidence as (
 select coalesce(string_agg('- ['||e.theme_key||'/'||e.relation||'] '||g.headline||'｜'||g.article_date,E'\n' order by e.theme_key,e.relation,e.evidence_rank),'（該当なし）') s
 from j join public.theme_deterministic_evidence_v6 e on e.analysis_run_id=j.analysis_run_id
 join public.formal_source_grounded_articles_v4 g on g.article_id=e.article_id
)
select '# 生活者ナラティブ分析：全件検証レポート'||E'\n\n## 統合ナラティブ\n'||crossn.s||E'\n\n## 主要テーマ\n'||themes.s||E'\n\n## 反証・制約\n'||limits.s||E'\n\n## 実務含意\n'||implications.s||E'\n\n## 仮説\n'||hypotheses.s||E'\n\n## 調査課題\n'||research.s||E'\n\n## 根拠記事\n'||evidence.s
from crossn,themes,limits,implications,hypotheses,research,evidence;
$$;

create or replace function public.formal_report_payload_v6(p_job_id uuid)
returns jsonb
language sql stable security definer
set search_path=pg_catalog,public
as $$
with j as (select * from public.formal_report_jobs_v6 where id=p_job_id),p as (select * from public.theme_analysis_proof_receipts_v6 where id=(select theme_proof_receipt_id from j))
select jsonb_build_object(
 'formal_gate_version','formal_report_v6_claim_graph','report_job_id',j.id,'analysis_run_id',j.analysis_run_id,'theme_proof_receipt_id',j.theme_proof_receipt_id,
 'full_corpus_gate','passed','count_gate','passed','semantic_evidence_gate','passed','claim_graph_gate','passed','source_grounding_gate','passed','counterevidence_gate','passed',
 'candidate_set_fingerprint',j.candidate_set_fingerprint,'census_identity_fingerprint',j.census_identity_fingerprint,'metrics_fingerprint',j.metrics_fingerprint,'selection_fingerprint',j.selection_fingerprint,'evidence_fingerprint',j.evidence_fingerprint,
 'selected_theme_count',j.selected_theme_count,
 'selected_themes',(select coalesce(jsonb_agg(jsonb_build_object('theme_key',s.theme_key,'title',s.title,'rank',s.selection_rank,'support_count',s.support_count,'counter_count',s.counter_count,'direct_consumer_support_count',s.direct_consumer_support_count,'support_page_count',s.support_page_count,'support_day_count',s.support_day_count) order by s.selection_rank),'[]'::jsonb) from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.selected_for_report),
 'evidence',(select coalesce(jsonb_agg(jsonb_build_object('theme_key',e.theme_key,'relation',e.relation,'rank',e.evidence_rank,'article_id',e.article_id,'source_region_sha256',e.source_region_sha256,'source_block_index',e.source_block_index,'source_block_sha256',e.source_block_sha256) order by e.theme_key,e.relation,e.evidence_rank),'[]'::jsonb) from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id),
 'proof_version','strict_report_v6_source_grounded_dual_census_claim_graph'
) from j,p;
$$;

create or replace function public.enforce_only_v6_formal_report_row()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_job uuid;j public.formal_report_jobs_v6%rowtype;begin
  if coalesce(new.answer_json->>'formal_gate_version','')='formal_report_v6_claim_graph' then
    begin v_job:=(new.answer_json->>'report_job_id')::uuid; exception when others then raise exception 'formal_v6_report_job_id_invalid'; end;
    select * into j from public.formal_report_jobs_v6 where id=v_job;
    if not found or j.status not in ('completed','published') or not public.formal_report_integrity_v6(j.id) then raise exception 'formal_v6_report_integrity_required'; end if;
    if new.answer_json<>public.formal_report_payload_v6(j.id) then raise exception 'formal_v6_payload_must_be_database_generated'; end if;
    new.answer_text:=public.render_formal_report_text_v6(j.id);
    new.related_article_ids:=public.formal_report_related_article_ids_v6(j.id);
    new.report_kind:='formal';new.generation_status:='completed';new.is_formal_report:=true;new.analysis_verification_status:='full_corpus_verified_v6';new.full_corpus_gate:='passed';
  else
    new.is_formal_report:=false;
    if coalesce(new.report_kind,'')='formal' then new.report_kind:='provisional'; end if;
    new.analysis_verification_status:='provisional_unverified';new.full_corpus_gate:='failed';
  end if;
  return new;
end $$;

-- Legacy report gates do not touch v6 payloads.
drop trigger if exists trg_0000_normalize_hierarchical_report_v1 on public.chat_reports;
create trigger trg_0000_normalize_hierarchical_report_v1 before insert or update of answer_json on public.chat_reports for each row when ((new.answer_json->>'formal_gate_version') is distinct from 'formal_report_v6_claim_graph') execute function public.normalize_hierarchical_report_before_gate_v1();
drop trigger if exists trg_000_quarantine_invalid_formal_attempt_v1 on public.chat_reports;
create trigger trg_000_quarantine_invalid_formal_attempt_v1 before insert or update of answer_json on public.chat_reports for each row when ((new.answer_json->>'formal_gate_version') is distinct from 'formal_report_v6_claim_graph') execute function public.quarantine_invalid_formal_report_attempt_v1();
drop trigger if exists trg_00_enforce_category_report_classification_v1 on public.chat_reports;
create trigger trg_00_enforce_category_report_classification_v1 before insert or update of answer_json on public.chat_reports for each row when ((new.answer_json->>'formal_gate_version') is distinct from 'formal_report_v6_claim_graph') execute function public.enforce_category_report_classification_v1();
drop trigger if exists trg_enforce_semantic_review_v2 on public.chat_reports;
create trigger trg_enforce_semantic_review_v2 before insert or update of answer_json on public.chat_reports for each row when ((new.answer_json->>'formal_gate_version') is distinct from 'formal_report_v6_claim_graph') execute function public.enforce_semantic_review_v2();
drop trigger if exists trg_sync_chat_report_metadata on public.chat_reports;
create trigger trg_sync_chat_report_metadata before insert or update of answer_json on public.chat_reports for each row when ((new.answer_json->>'formal_gate_version') is distinct from 'formal_report_v6_claim_graph') execute function public.sync_chat_report_metadata();
drop trigger if exists trg_zzzz_enforce_aaaa_formal_contract_v1 on public.chat_reports;
create trigger trg_zzzz_enforce_aaaa_formal_contract_v1 before insert or update of answer_json on public.chat_reports for each row when ((new.answer_json->>'formal_gate_version') is distinct from 'formal_report_v6_claim_graph') execute function public.enforce_aaaa_formal_contract_v1();
drop trigger if exists trg_zzzzzz_enforce_only_v6_formal on public.chat_reports;
create trigger trg_zzzzzz_enforce_only_v6_formal before insert or update on public.chat_reports for each row execute function public.enforce_only_v6_formal_report_row();

create or replace function public.publish_formal_report_v6(p_job_id uuid,p_source_job_id uuid default null)
returns uuid
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;v_report uuid;begin
  select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;
  if not found or j.status not in ('completed','published') or not public.formal_report_integrity_v6(j.id) then raise exception 'publish_v6_report_not_verified'; end if;
  if j.report_id is not null then return j.report_id; end if;
  insert into public.chat_reports(user_query,answer_text,answer_json,related_article_ids,report_kind,generation_status,is_formal_report,analysis_verification_status,full_corpus_gate,source_job_id)
  values(j.user_query,public.render_formal_report_text_v6(j.id),public.formal_report_payload_v6(j.id),public.formal_report_related_article_ids_v6(j.id),'formal','completed',true,'full_corpus_verified_v6','passed',p_source_job_id)
  returning id into v_report;
  update public.formal_report_jobs_v6 set status='published',report_id=v_report,updated_at=now() where id=j.id;
  return v_report;
end $$;

revoke execute on function public.formal_report_related_article_ids_v6(uuid),public.render_formal_report_text_v6(uuid),public.formal_report_payload_v6(uuid),public.publish_formal_report_v6(uuid,uuid) from public,anon,authenticated;
grant execute on function public.formal_report_related_article_ids_v6(uuid),public.render_formal_report_text_v6(uuid),public.formal_report_payload_v6(uuid),public.publish_formal_report_v6(uuid,uuid) to service_role;