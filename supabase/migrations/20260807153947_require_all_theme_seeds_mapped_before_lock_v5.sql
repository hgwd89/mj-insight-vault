create or replace function public.lock_theme_candidate_set_v5(p_analysis_run_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.theme_analysis_runs_v4%rowtype;v_seed record;v_jobs integer;v_completed integer;v_fp text;v_rejected integer;begin
  select * into a from public.theme_analysis_runs_v4 where id=p_analysis_run_id for update;if not found or a.status<>'discovering' then raise exception 'theme_lock_v5_run_not_discovering';end if;
  select * into v_seed from public.theme_seed_set_proof_v5(a.scan_run_id);if v_seed.seed_count<>a.expected_seed_count then raise exception 'theme_lock_v5_seed_set_stale';end if;
  select count(*)::integer,count(*) filter(where status='completed')::integer into v_jobs,v_completed from public.theme_seed_mapping_jobs_v5 where analysis_run_id=a.id;if v_jobs=0 or v_completed<>v_jobs then raise exception 'theme_lock_v5_mapping_jobs_incomplete';end if;
  if (select count(*) from public.theme_seed_mappings_v4 where analysis_run_id=a.id and mapping_version='theme_seed_mapping_v5_dual')<>a.expected_seed_count then raise exception 'theme_lock_v5_mapping_count_mismatch';end if;
  select count(*)::integer into v_rejected from public.theme_seed_mappings_v4 where analysis_run_id=a.id and mapping_version='theme_seed_mapping_v5_dual' and mapping_status='rejected';
  if v_rejected>0 then raise exception 'theme_lock_v5_unmapped_theme_seeds_remaining: %',v_rejected;end if;
  if exists(select 1 from public.theme_candidates_v4 c where c.analysis_run_id=a.id and not exists(select 1 from public.theme_seed_mappings_v4 m where m.analysis_run_id=a.id and m.candidate_id=c.id and m.mapping_status='mapped' and m.mapping_version='theme_seed_mapping_v5_dual')) then raise exception 'theme_lock_v5_candidate_without_mapped_seed';end if;
  v_fp:=public.lock_theme_candidate_set_v4(a.id);
  return jsonb_build_object('status','candidate_locked','candidate_set_fingerprint',v_fp,'seed_count',a.expected_seed_count,'candidate_count',(select count(*) from public.theme_candidates_v4 where analysis_run_id=a.id),'rejected_seed_count',0);
end $$;

create function public.reset_theme_candidate_discovery_v5(p_analysis_run_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.theme_analysis_runs_v4%rowtype;j public.theme_candidate_synthesis_jobs_v5%rowtype;begin
  select * into a from public.theme_analysis_runs_v4 where id=p_analysis_run_id for update;if not found or a.candidate_set_locked_at is not null or a.status<>'discovering' then raise exception 'theme_reset_v5_only_before_candidate_lock';end if;
  select * into j from public.theme_candidate_synthesis_jobs_v5 where analysis_run_id=a.id;if not found then raise exception 'theme_reset_v5_synthesis_job_missing';end if;
  delete from public.theme_seed_mapping_stage_v5 where job_id in (select id from public.theme_seed_mapping_jobs_v5 where analysis_run_id=a.id);
  delete from public.theme_seed_mapping_pass_runs_v5 where job_id in (select id from public.theme_seed_mapping_jobs_v5 where analysis_run_id=a.id);
  delete from public.theme_seed_mapping_jobs_v5 where analysis_run_id=a.id;
  delete from public.theme_seed_mappings_v4 where analysis_run_id=a.id;
  delete from public.theme_candidates_v4 where analysis_run_id=a.id;
  delete from public.theme_candidate_critic_rows_v5 where job_id=j.id;
  delete from public.theme_candidate_proposals_v5 where job_id=j.id;
  delete from public.theme_candidate_synthesis_pass_runs_v5 where job_id=j.id;
  update public.theme_candidate_synthesis_jobs_v5 set status='queued',attempt_count=0,lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class='manual_reset',error_message=left(coalesce(p_reason,'candidate coverage reset'),1500),started_at=null,finished_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','analysis_run_id',a.id,'reason',coalesce(p_reason,'candidate coverage reset'));
end $$;
revoke execute on function public.reset_theme_candidate_discovery_v5(uuid,text) from public,anon,authenticated;grant execute on function public.reset_theme_candidate_discovery_v5(uuid,text) to service_role;