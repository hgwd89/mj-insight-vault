create or replace function public.record_source_page_article_inventory_pass_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_pass_kind text,
  p_model text,
  p_provider_response_id text,
  p_prompt_sha256 text,
  p_response_sha256 text,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
set statement_timeout to '90s'
as $function$
declare
  v_result jsonb;
  v_mapper text[];
  v_critic text[];
  v_norm jsonb;
  v_version text;
  v_required boolean;
begin
  select public.replace_source_page_article_inventory_pass_v1(
    p_job_id,p_lease_token,p_pass_kind,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256,p_groups
  ) into v_result;

  if p_pass_kind='critic' then
    select inventory_version into v_version from public.source_page_article_inventory_jobs_v1 where id=p_job_id;
    if v_version='page_article_inventory_v4_recovered_ocr' then
      v_norm:=public.try_normalize_visual_inventory_two_pass_v4(p_job_id,p_lease_token);
      select requires_third_pass into v_required from public.source_page_article_inventory_jobs_v1 where id=p_job_id;
      v_result:=v_result||jsonb_build_object(
        'requires_third_pass',coalesce(v_required,true),
        'disagreement_detected',not coalesce((v_norm->>'normalized')::boolean,false),
        'visual_consensus',v_norm
      );
    else
      select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[]) into v_mapper
      from public.source_page_article_inventory_groups_v1 where job_id=p_job_id and pass_kind='mapper';
      select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[]) into v_critic
      from public.source_page_article_inventory_groups_v1 where job_id=p_job_id and pass_kind='critic';
      if v_mapper is distinct from v_critic then
        update public.source_page_article_inventory_jobs_v1
           set requires_third_pass=true,updated_at=now()
         where id=p_job_id and status='running' and lease_token is not distinct from p_lease_token;
        v_result:=v_result||jsonb_build_object('requires_third_pass',true,'disagreement_detected',true);
      else
        v_result:=v_result||jsonb_build_object('requires_third_pass',false,'disagreement_detected',false);
      end if;
    end if;
  end if;
  return v_result;
end
$function$;
