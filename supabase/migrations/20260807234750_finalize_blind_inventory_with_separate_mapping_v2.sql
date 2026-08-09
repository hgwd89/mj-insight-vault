create or replace function public.enforce_blind_inventory_group_v2()
returns trigger
language plpgsql
set search_path=pg_catalog,public
as $$begin
 if new.group_kind='article' and new.mapped_article_id is not null then raise exception 'blind_inventory_groups_cannot_map_existing_articles';end if;
 return new;
end$$;
drop trigger if exists trg_enforce_blind_inventory_group_v2 on public.source_page_article_inventory_groups_v1;
create trigger trg_enforce_blind_inventory_group_v2 before insert or update of mapped_article_id,group_kind on public.source_page_article_inventory_groups_v1 for each row execute function public.enforce_blind_inventory_group_v2();
revoke all on function public.enforce_blind_inventory_group_v2() from public,anon,authenticated;

create or replace function public.replace_inventory_mapping_pass_v2(
 p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_mappings jsonb
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.source_page_article_inventory_jobs_v1%rowtype;m jsonb;v_groups integer;v_rows integer;begin
 if p_pass_kind not in ('mapper','critic') then raise exception 'inventory_mapping_v2_bad_pass_kind';end if;
 select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'inventory_mapping_v2_lease_invalid';end if;
 if jsonb_typeof(p_mappings)<>'array' then raise exception 'inventory_mapping_v2_array_required';end if;
 select count(*)::integer into v_groups from public.source_page_article_inventory_consensus_groups_v2 where job_id=j.id;
 if jsonb_array_length(p_mappings)<>v_groups then raise exception 'inventory_mapping_v2_row_count_mismatch';end if;
 if exists(select 1 from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id and (model=p_model or provider_response_id=p_provider_response_id or prompt_sha256=p_prompt_sha256)) then raise exception 'inventory_mapping_v2_independent_pass_required';end if;
 delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind=p_pass_kind;
 delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id and pass_kind=p_pass_kind;
 insert into public.source_page_article_inventory_mapping_pass_runs_v2(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256) values(j.id,p_pass_kind,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256);
 for m in select value from jsonb_array_elements(p_mappings) loop
   if not exists(select 1 from public.source_page_article_inventory_consensus_groups_v2 g where g.job_id=j.id and g.group_fingerprint=m->>'group_fingerprint') then raise exception 'inventory_mapping_v2_unknown_group';end if;
   if not exists(select 1 from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where a.id=(m->>'article_id')::uuid and cm.page_identity_source_image_id=j.page_identity_source_image_id) then raise exception 'inventory_mapping_v2_article_not_on_page';end if;
   if coalesce((m->>'confidence')::numeric,0)<0.80 then raise exception 'inventory_mapping_v2_low_confidence';end if;
   insert into public.source_page_article_inventory_mapping_stage_v2(job_id,pass_kind,group_fingerprint,article_id,confidence,rationale)
   values(j.id,p_pass_kind,m->>'group_fingerprint',(m->>'article_id')::uuid,(m->>'confidence')::numeric,m->>'rationale');
 end loop;
 select count(*)::integer into v_rows from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind=p_pass_kind;
 if v_rows<>v_groups or (select count(distinct article_id) from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind=p_pass_kind)<>v_groups then raise exception 'inventory_mapping_v2_not_bijective';end if;
 return jsonb_build_object('status','stored','rows',v_rows);
end$$;
revoke all on function public.replace_inventory_mapping_pass_v2(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.replace_inventory_mapping_pass_v2(uuid,uuid,text,text,text,text,text,jsonb) to service_role;

create or replace function public.finalize_source_page_article_inventory_job_v1(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.source_page_article_inventory_jobs_v1%rowtype;v_passes integer;v_expected_passes integer;v_mapper_articles integer;v_critic_articles integer;v_adjudicator_articles integer;v_mismatch integer:=0;v_set record;v_resolved integer;v_map_passes integer;begin
 select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'inventory_v2_lease_invalid';end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'inventory_v2_freeze_stale';end if;
 select * into v_set from public.inventory_page_article_set_proof_v1(j.page_identity_source_image_id);
 if v_set.article_count<>j.existing_article_count or v_set.article_set_fingerprint<>j.page_article_set_fingerprint then raise exception 'inventory_v2_page_article_set_stale';end if;
 v_expected_passes:=case when j.requires_third_pass then 3 else 2 end;
 select count(*)::integer into v_passes from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id;
 if v_passes<>v_expected_passes then raise exception 'inventory_v2_blind_pass_receipts_incomplete';end if;
 select count(*)::integer into v_mapper_articles from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article';
 select count(*)::integer into v_critic_articles from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='critic' and group_kind='article';
 if v_mapper_articles<>v_critic_articles then v_mismatch:=v_mismatch+1;end if;
 if exists((select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article' except select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='critic' and group_kind='article') union all (select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='critic' and group_kind='article' except select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article')) then v_mismatch:=v_mismatch+1;end if;
 if j.requires_third_pass then
   select count(*)::integer into v_adjudicator_articles from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='adjudicator' and group_kind='article';
   if v_adjudicator_articles<>v_mapper_articles or exists((select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article' except select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='adjudicator' and group_kind='article') union all (select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='adjudicator' and group_kind='article' except select group_fingerprint from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article')) then v_mismatch:=v_mismatch+1;end if;
 end if;
 if v_mismatch>0 then update public.source_page_article_inventory_jobs_v1 set status='needs_review',lease_token=null,lease_expires_at=null,error_message='blind article inventories disagree',updated_at=now() where id=j.id;return jsonb_build_object('status','needs_review','reason','blind_inventory_disagreement');end if;
 if v_mapper_articles<>j.existing_article_count then
   update public.source_page_article_inventory_jobs_v1 set status=case when v_mapper_articles>j.existing_article_count then 'discovery_required' else 'needs_review' end,lease_token=null,lease_expires_at=null,error_message=format('blind inventory article count %s differs from frozen count %s',v_mapper_articles,j.existing_article_count),updated_at=now(),finished_at=case when v_mapper_articles>j.existing_article_count then now() else null end where id=j.id;
   return jsonb_build_object('status',case when v_mapper_articles>j.existing_article_count then 'discovery_required' else 'needs_review' end,'inventory_article_count',v_mapper_articles,'frozen_article_count',j.existing_article_count);
 end if;
 perform public.resolve_inventory_mapping_auto_v2(j.id);
 select count(*)::integer into v_resolved from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
 if v_resolved<j.existing_article_count then
   select count(*)::integer into v_map_passes from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id;
   if v_map_passes<>2 or exists((select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='mapper' except select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='critic') union all (select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='critic' except select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='mapper')) then
     update public.source_page_article_inventory_jobs_v1 set status='needs_review',lease_token=null,lease_expires_at=null,error_message=format('article mapping review required: resolved %s/%s',v_resolved,j.existing_article_count),updated_at=now() where id=j.id;
     return jsonb_build_object('status','needs_review','reason','article_mapping_review_required','auto_resolved',v_resolved,'expected',j.existing_article_count);
   end if;
   insert into public.source_page_article_inventory_mappings_v2(job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin)
   select j.id,s.group_fingerprint,s.article_id,'dual_review',least(m.confidence,c.confidence),null
   from public.source_page_article_inventory_mapping_stage_v2 m join public.source_page_article_inventory_mapping_stage_v2 c on c.job_id=m.job_id and c.pass_kind='critic' and c.group_fingerprint=m.group_fingerprint and c.article_id=m.article_id
   join public.source_page_article_inventory_mapping_stage_v2 s on s.job_id=m.job_id and s.pass_kind='mapper' and s.group_fingerprint=m.group_fingerprint
   where m.job_id=j.id and m.pass_kind='mapper'
   on conflict(job_id,group_fingerprint) do nothing;
 end if;
 select count(*)::integer into v_resolved from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
 if v_resolved<>j.existing_article_count or (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 where job_id=j.id)<>j.existing_article_count then raise exception 'inventory_v2_final_mapping_not_bijective';end if;
 if exists((select article_id from public.source_page_article_inventory_mappings_v2 where job_id=j.id except select a.id from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id) union all (select a.id from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id except select article_id from public.source_page_article_inventory_mappings_v2 where job_id=j.id)) then raise exception 'inventory_v2_mapping_article_set_mismatch';end if;
 update public.source_page_article_inventory_jobs_v1 set status='completed',lease_token=null,lease_expires_at=null,error_message=null,updated_at=now(),finished_at=now() where id=j.id;
 return jsonb_build_object('status','completed','inventory_article_count',v_mapper_articles,'mapped_articles',v_resolved,'third_pass',j.requires_third_pass);
end$$;
