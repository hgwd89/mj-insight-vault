create or replace function public.consolidate_inventory_continuation_groups_v1(p_job_id uuid, p_group_a text, p_group_b text, p_continuation_article_id uuid, p_remaining_group text, p_remaining_article_id uuid, p_anchor_a text, p_anchor_b text, p_remaining_anchor text, p_reason text)
returns jsonb
language plpgsql
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  ga record; gb record; gr record;
  ca public.articles%rowtype; ra public.articles%rowtype;
  v_current_freeze uuid;
  v_group_count integer;
  v_union integer[];
  v_union_count integer;
  v_overlap_count integer;
  v_combined_text text;
  v_combined_fp text;
  v_old_consensus_fp text;
  v_new_consensus_fp text;
  v_evidence_sha text;
  v_conf numeric;
  v_selected text;
  v_target_set uuid[];
  v_page_set uuid[];
begin
  if exists(select 1 from public.inventory_v3_execution_control_v1 where singleton=true and enabled) then raise exception 'semantic_continuation_requires_inventory_execution_disabled'; end if;
  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_current_freeze is null then raise exception 'semantic_continuation_current_freeze_missing'; end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found then raise exception 'semantic_continuation_job_missing'; end if;
  if j.freeze_receipt_id is distinct from v_current_freeze or j.inventory_version<>'page_article_inventory_v4_recovered_ocr' then raise exception 'semantic_continuation_job_not_current'; end if;
  if j.status<>'discovery_required' then raise exception 'semantic_continuation_requires_discovery_required'; end if;
  if j.existing_article_count<>2 then raise exception 'semantic_continuation_exactly_two_existing_required'; end if;
  if j.requires_third_pass then raise exception 'semantic_continuation_two_pass_consensus_required'; end if;
  if (select count(*) from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id)<>2 then raise exception 'semantic_continuation_two_pass_receipts_required'; end if;
  v_selected:=public.inventory_consensus_source_v3(j.id);
  if v_selected is null then raise exception 'semantic_continuation_pair_consensus_missing'; end if;
  select count(*) into v_group_count from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id;
  if v_group_count<>3 then raise exception 'semantic_continuation_exactly_three_consensus_groups_required'; end if;
  select * into ga from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=p_group_a;
  select * into gb from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=p_group_b;
  select * into gr from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=p_remaining_group;
  if ga.job_id is null or gb.job_id is null or gr.job_id is null or p_group_a=p_group_b or p_group_a=p_remaining_group or p_group_b=p_remaining_group then raise exception 'semantic_continuation_distinct_groups_required'; end if;
  select * into ca from public.articles where id=p_continuation_article_id;
  select * into ra from public.articles where id=p_remaining_article_id;
  if ca.id is null or ra.id is null or ca.id=ra.id then raise exception 'semantic_continuation_distinct_articles_required'; end if;
  select array_agg(a.id order by a.id) into v_page_set from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id;
  select array_agg(x order by x) into v_target_set from unnest(array[p_continuation_article_id,p_remaining_article_id]) x;
  if coalesce(array_length(v_page_set,1),0)<>2 or v_page_set is distinct from v_target_set then raise exception 'semantic_continuation_target_article_set_mismatch'; end if;
  if char_length(btrim(coalesce(p_anchor_a,'')))<6 or char_length(btrim(coalesce(p_anchor_b,'')))<6 or char_length(btrim(coalesce(p_remaining_anchor,'')))<6 then raise exception 'semantic_continuation_anchor_too_short'; end if;
  if position(lower(p_anchor_a) in lower(coalesce(ga.group_text,'')))=0 or position(lower(p_anchor_a) in lower(coalesce(ca.analysis_body_clean,'')))=0 then raise exception 'semantic_continuation_anchor_a_not_grounded'; end if;
  if position(lower(p_anchor_b) in lower(coalesce(gb.group_text,'')))=0 or position(lower(p_anchor_b) in lower(coalesce(ca.analysis_body_clean,'')))=0 then raise exception 'semantic_continuation_anchor_b_not_grounded'; end if;
  if position(lower(p_remaining_anchor) in lower(coalesce(gr.group_text,'')))=0 or position(lower(p_remaining_anchor) in lower(coalesce(ra.analysis_body_clean,'')))=0 then raise exception 'semantic_continuation_remaining_anchor_not_grounded'; end if;
  select count(*) into v_overlap_count from (select unnest(ga.block_indices) intersect select unnest(gb.block_indices)) q;
  if v_overlap_count<>0 then raise exception 'semantic_continuation_groups_overlap'; end if;
  select array_agg(x order by x),count(*) into v_union,v_union_count from (select distinct unnest(ga.block_indices) x union select distinct unnest(gb.block_indices) x) u;
  if v_union_count<>coalesce(array_length(ga.block_indices,1),0)+coalesce(array_length(gb.block_indices,1),0) then raise exception 'semantic_continuation_union_not_exact'; end if;
  select string_agg(b.block_text,E'\n---\n' order by b.block_index) into v_combined_text from public.source_page_article_inventory_blocks_v1 b where b.job_id=j.id and b.block_index=any(v_union);
  if coalesce(v_combined_text,'')='' then raise exception 'semantic_continuation_combined_text_missing'; end if;
  v_combined_fp:=encode(extensions.digest(convert_to(j.source_ocr_json_sha256||'|semantic_continuation_v1|'||array_to_string(v_union,',')||'|'||p_continuation_article_id::text||'|'||v_combined_text,'UTF8'),'sha256'),'hex');
  v_conf:=least(ga.confidence,gb.confidence);
  select consensus_fingerprint into v_old_consensus_fp from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=j.id;
  if coalesce(v_old_consensus_fp,'') !~ '^[0-9a-f]{64}$' then raise exception 'semantic_continuation_visual_receipt_missing'; end if;
  v_new_consensus_fp:=encode(extensions.digest(convert_to(j.source_ocr_json_sha256||'|semantic_continuation_v1|'||v_combined_fp||'|'||p_remaining_group||'|'||p_continuation_article_id::text||'|'||p_remaining_article_id::text,'UTF8'),'sha256'),'hex');
  v_evidence_sha:=encode(extensions.digest(convert_to(j.id::text||'|'||p_group_a||'|'||p_group_b||'|'||p_remaining_group||'|'||v_combined_fp||'|'||p_anchor_a||'|'||p_anchor_b||'|'||p_remaining_anchor||'|'||v_old_consensus_fp,'UTF8'),'sha256'),'hex');
  delete from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id;
  insert into public.source_page_inventory_semantic_group_consolidation_receipts_v1(job_id,original_group_fingerprints,combined_group_fingerprint,continuation_article_id,remaining_group_fingerprint,remaining_article_id,anchor_evidence,original_consensus_fingerprint,consolidated_consensus_fingerprint,reason,evidence_sha256)
  values(j.id,array[p_group_a,p_group_b],v_combined_fp,p_continuation_article_id,p_remaining_group,p_remaining_article_id,jsonb_build_object('group_a_anchor',p_anchor_a,'group_b_anchor',p_anchor_b,'remaining_anchor',p_remaining_anchor,'group_a_blocks',ga.block_indices,'group_b_blocks',gb.block_indices,'combined_blocks',v_union,'selected_raw_consensus_pass',v_selected),v_old_consensus_fp,v_new_consensus_fp,p_reason,v_evidence_sha);
  if (select count(*) from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id)<>2 then raise exception 'semantic_continuation_effective_group_count_invalid'; end if;
  if not exists(select 1 from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=v_combined_fp and block_indices=v_union) then raise exception 'semantic_continuation_synthesized_group_missing'; end if;
  insert into public.source_page_article_inventory_mappings_v2(job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin) values (j.id,v_combined_fp,p_continuation_article_id,'semantic_review',v_conf,1.0),(j.id,p_remaining_group,p_remaining_article_id,'semantic_review',gr.confidence,1.0);
  if (select consensus_fingerprint from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=j.id) is distinct from v_old_consensus_fp then raise exception 'semantic_continuation_visual_receipt_mutated'; end if;
  if (select count(*) from public.source_page_article_inventory_mappings_v2 where job_id=j.id)<>2 or (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 where job_id=j.id)<>2 then raise exception 'semantic_continuation_mapping_not_bijective'; end if;
  if exists((select article_id from public.source_page_article_inventory_mappings_v2 where job_id=j.id except select unnest(v_page_set)) union all (select unnest(v_page_set) except select article_id from public.source_page_article_inventory_mappings_v2 where job_id=j.id)) then raise exception 'semantic_continuation_mapping_article_set_mismatch'; end if;
  update public.source_page_article_inventory_jobs_v1 set status='needs_review',requires_third_pass=false,lease_token=null,lease_expires_at=null,error_message='semantic continuation consolidated; formal completion requires enabled execution control',finished_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','needs_review','job_id',j.id,'combined_group_fingerprint',v_combined_fp,'combined_blocks',v_union,'continuation_article_id',p_continuation_article_id,'remaining_article_id',p_remaining_article_id,'evidence_sha256',v_evidence_sha,'visual_consensus_fingerprint',v_old_consensus_fp,'semantic_consensus_fingerprint',v_new_consensus_fp,'article_count',2,'materialized',false);
end
$function$;

create or replace function public.consolidate_inventory_continuation_groups_trimmed_v1(p_job_id uuid, p_group_a text, p_group_b text, p_group_b_include integer[], p_continuation_article_id uuid, p_remaining_group text, p_remaining_article_id uuid, p_anchor_a text, p_anchor_b text, p_remaining_anchor text, p_exclusion_anchor text, p_reason text)
returns jsonb
language plpgsql
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  ga record; gb record; gr record;
  ca public.articles%rowtype; ra public.articles%rowtype;
  v_current_freeze uuid;
  v_selected text;
  v_group_count integer;
  v_include integer[];
  v_excluded integer[];
  v_combined integer[];
  v_combined_text text;
  v_include_text text;
  v_excluded_text text;
  v_combined_fp text;
  v_old_consensus_fp text;
  v_new_consensus_fp text;
  v_evidence_sha text;
  v_page_set uuid[];
  v_target_set uuid[];
begin
  if exists(select 1 from public.inventory_v3_execution_control_v1 where singleton=true and enabled) then raise exception 'trimmed_continuation_requires_inventory_execution_disabled'; end if;
  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_current_freeze is null then raise exception 'trimmed_continuation_current_freeze_missing'; end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found then raise exception 'trimmed_continuation_job_missing'; end if;
  if j.freeze_receipt_id is distinct from v_current_freeze or j.inventory_version<>'page_article_inventory_v4_recovered_ocr' then raise exception 'trimmed_continuation_job_not_current'; end if;
  if j.status<>'discovery_required' or j.existing_article_count<>2 or j.requires_third_pass then raise exception 'trimmed_continuation_job_state_invalid'; end if;
  if (select count(*) from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id)<>2 then raise exception 'trimmed_continuation_two_pass_receipts_required'; end if;
  if exists(select 1 from public.source_page_inventory_semantic_group_consolidation_receipts_v1 where job_id=j.id) then raise exception 'trimmed_continuation_receipt_already_exists'; end if;
  v_selected:=public.inventory_consensus_source_v3(j.id);
  if v_selected is null then raise exception 'trimmed_continuation_pair_consensus_missing'; end if;
  select count(*) into v_group_count from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id;
  if v_group_count<>3 then raise exception 'trimmed_continuation_exactly_three_groups_required'; end if;
  select * into ga from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=p_group_a;
  select * into gb from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=p_group_b;
  select * into gr from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=p_remaining_group;
  if ga.job_id is null or gb.job_id is null or gr.job_id is null or p_group_a=p_group_b or p_group_a=p_remaining_group or p_group_b=p_remaining_group then raise exception 'trimmed_continuation_distinct_groups_required'; end if;
  select * into ca from public.articles where id=p_continuation_article_id;
  select * into ra from public.articles where id=p_remaining_article_id;
  if ca.id is null or ra.id is null or ca.id=ra.id then raise exception 'trimmed_continuation_distinct_articles_required'; end if;
  select array_agg(a.id order by a.id) into v_page_set from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id;
  select array_agg(x order by x) into v_target_set from unnest(array[p_continuation_article_id,p_remaining_article_id]) x;
  if coalesce(array_length(v_page_set,1),0)<>2 or v_page_set is distinct from v_target_set then raise exception 'trimmed_continuation_target_article_set_mismatch'; end if;
  select array_agg(distinct x order by x) into v_include from unnest(p_group_b_include) x;
  if coalesce(array_length(v_include,1),0)=0 then raise exception 'trimmed_continuation_include_required'; end if;
  if exists(select 1 from unnest(v_include) x where not (x=any(gb.block_indices))) then raise exception 'trimmed_continuation_include_not_subset'; end if;
  select array_agg(x order by x) into v_excluded from unnest(gb.block_indices) x where not (x=any(v_include));
  if coalesce(array_length(v_excluded,1),0)=0 then raise exception 'trimmed_continuation_excluded_blocks_required'; end if;
  if exists(select 1 from unnest(ga.block_indices) a join unnest(v_include) b on a=b) then raise exception 'trimmed_continuation_article_blocks_overlap'; end if;
  select array_agg(x order by x) into v_combined from (select distinct unnest(ga.block_indices) x union select distinct unnest(v_include) x) q;
  select string_agg(block_text,E'\n---\n' order by block_index) into v_include_text from public.source_page_article_inventory_blocks_v1 where job_id=j.id and block_index=any(v_include);
  select string_agg(block_text,E'\n---\n' order by block_index) into v_excluded_text from public.source_page_article_inventory_blocks_v1 where job_id=j.id and block_index=any(v_excluded);
  select string_agg(block_text,E'\n---\n' order by block_index) into v_combined_text from public.source_page_article_inventory_blocks_v1 where job_id=j.id and block_index=any(v_combined);
  if char_length(btrim(coalesce(p_anchor_a,'')))<4 or char_length(btrim(coalesce(p_anchor_b,'')))<4 or char_length(btrim(coalesce(p_remaining_anchor,'')))<4 or char_length(btrim(coalesce(p_exclusion_anchor,'')))<4 then raise exception 'trimmed_continuation_anchor_too_short'; end if;
  if position(lower(p_anchor_a) in lower(coalesce(ga.group_text,'')))=0 or position(lower(p_anchor_a) in lower(coalesce(ca.analysis_body_clean,'')))=0 then raise exception 'trimmed_continuation_anchor_a_not_grounded'; end if;
  if position(lower(p_anchor_b) in lower(coalesce(v_include_text,'')))=0 or position(lower(p_anchor_b) in lower(coalesce(ca.analysis_body_clean,'')))=0 then raise exception 'trimmed_continuation_anchor_b_not_grounded'; end if;
  if position(lower(p_remaining_anchor) in lower(coalesce(gr.group_text,'')))=0 or position(lower(p_remaining_anchor) in lower(coalesce(ra.analysis_body_clean,'')))=0 then raise exception 'trimmed_continuation_remaining_anchor_not_grounded'; end if;
  if position(lower(p_exclusion_anchor) in lower(coalesce(v_excluded_text,'')))=0 then raise exception 'trimmed_continuation_exclusion_anchor_not_in_excluded'; end if;
  if position(lower(p_exclusion_anchor) in lower(coalesce(ca.analysis_body_clean,'')))>0 then raise exception 'trimmed_continuation_exclusion_anchor_in_target_article'; end if;
  v_combined_fp:=encode(extensions.digest(convert_to(j.source_ocr_json_sha256||'|semantic_trimmed_continuation_v1|'||array_to_string(v_combined,',')||'|'||array_to_string(v_excluded,',')||'|'||p_continuation_article_id::text||'|'||coalesce(v_combined_text,''),'UTF8'),'sha256'),'hex');
  select consensus_fingerprint into v_old_consensus_fp from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=j.id;
  if coalesce(v_old_consensus_fp,'') !~ '^[0-9a-f]{64}$' then raise exception 'trimmed_continuation_visual_receipt_missing'; end if;
  v_new_consensus_fp:=encode(extensions.digest(convert_to(j.source_ocr_json_sha256||'|semantic_trimmed_continuation_v1|'||v_combined_fp||'|'||p_remaining_group||'|'||p_continuation_article_id::text||'|'||p_remaining_article_id::text,'UTF8'),'sha256'),'hex');
  v_evidence_sha:=encode(extensions.digest(convert_to(j.id::text||'|'||p_group_a||'|'||p_group_b||'|'||array_to_string(v_include,',')||'|'||array_to_string(v_excluded,',')||'|'||p_remaining_group||'|'||p_anchor_a||'|'||p_anchor_b||'|'||p_remaining_anchor||'|'||p_exclusion_anchor||'|'||v_old_consensus_fp,'UTF8'),'sha256'),'hex');
  delete from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id;
  insert into public.source_page_inventory_semantic_group_consolidation_receipts_v1(job_id,original_group_fingerprints,combined_group_fingerprint,continuation_article_id,remaining_group_fingerprint,remaining_article_id,anchor_evidence,original_consensus_fingerprint,consolidated_consensus_fingerprint,reason,evidence_sha256)
  values(j.id,array[p_group_a,p_group_b],v_combined_fp,p_continuation_article_id,p_remaining_group,p_remaining_article_id,jsonb_build_object('group_a_anchor',p_anchor_a,'group_b_anchor',p_anchor_b,'remaining_anchor',p_remaining_anchor,'exclusion_anchor',p_exclusion_anchor,'group_a_blocks',ga.block_indices,'group_b_blocks',gb.block_indices,'included_group_b_blocks',v_include,'excluded_blocks',v_excluded,'combined_blocks',v_combined,'selected_raw_consensus_pass',v_selected),v_old_consensus_fp,v_new_consensus_fp,p_reason,v_evidence_sha);
  if (select count(*) from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id)<>2 then raise exception 'trimmed_continuation_effective_group_count_invalid'; end if;
  if not exists(select 1 from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id and group_fingerprint=v_combined_fp and block_indices=v_combined) then raise exception 'trimmed_continuation_synthesized_group_missing'; end if;
  insert into public.source_page_article_inventory_mappings_v2(job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin) values(j.id,v_combined_fp,p_continuation_article_id,'semantic_review',least(ga.confidence,gb.confidence),1.0),(j.id,p_remaining_group,p_remaining_article_id,'semantic_review',gr.confidence,1.0);
  if (select consensus_fingerprint from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=j.id) is distinct from v_old_consensus_fp then raise exception 'trimmed_continuation_visual_receipt_mutated'; end if;
  update public.source_page_article_inventory_jobs_v1 set status='needs_review',requires_third_pass=false,lease_token=null,lease_expires_at=null,error_message='semantic trimmed continuation consolidated; formal completion requires enabled execution control',finished_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','needs_review','job_id',j.id,'combined_group_fingerprint',v_combined_fp,'combined_blocks',v_combined,'excluded_blocks',v_excluded,'continuation_article_id',p_continuation_article_id,'remaining_article_id',p_remaining_article_id,'evidence_sha256',v_evidence_sha,'visual_consensus_fingerprint',v_old_consensus_fp,'semantic_consensus_fingerprint',v_new_consensus_fp,'materialized',false);
end
$function$;
