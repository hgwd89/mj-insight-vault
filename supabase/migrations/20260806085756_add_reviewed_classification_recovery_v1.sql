create or replace function public.recover_reviewed_article_classifications_v1(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_item jsonb;
  v_job_id uuid;
  v_article_id uuid;
  v_token uuid;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_review_model text;
  v_review_basis text;
begin
  if jsonb_typeof(p_items)<>'array' then
    raise exception using errcode='22023',message='classification_recovery_items_array_required';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    begin
      v_job_id := (v_item->>'job_id')::uuid;
      v_review_model := coalesce(nullif(btrim(v_item->>'review_model'),''),'gpt-5.6-thinking');
      v_review_basis := coalesce(nullif(btrim(v_item->>'review_basis'),''),'headline_and_reconstructed_article_text');
      v_token := gen_random_uuid();

      update public.article_classification_jobs
      set status='running',
          attempt_count=greatest(attempt_count,1),
          lease_token=v_token,
          lease_expires_at=now()+interval '10 minutes',
          heartbeat_at=now(),
          next_retry_at=null,
          error_message=null,
          updated_at=now(),
          finished_at=null
      where id=v_job_id
        and status in ('failed','queued')
      returning article_id into v_article_id;

      if v_article_id is null then
        raise exception using errcode='P0002',message='classification_recovery_job_not_available';
      end if;

      v_result := public.complete_article_classification_job_v2(
        v_job_id,
        v_token,
        coalesce(v_item->'profile','{}'::jsonb) || jsonb_build_object(
          'recovery_mode','assistant_manual_review',
          'review_model',v_review_model,
          'review_basis',v_review_basis,
          'reviewed_at',now()
        ),
        coalesce(v_item->'memberships','[]'::jsonb)
      );

      update public.article_profiles
      set profile_json = coalesce(profile_json,'{}'::jsonb) || jsonb_build_object(
            'model_used',v_review_model,
            'recovery_mode','assistant_manual_review',
            'review_basis',v_review_basis,
            'reviewed_at',now()
          ),
          updated_at=now()
      where article_id=v_article_id;

      update public.article_classification_jobs
      set result_json = coalesce(result_json,'{}'::jsonb) || jsonb_build_object(
            'recovery_mode','assistant_manual_review',
            'review_model',v_review_model,
            'review_basis',v_review_basis,
            'reviewed_at',now()
          ),
          updated_at=now()
      where id=v_job_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'job_id',v_job_id,'article_id',v_article_id,'status','completed','result',v_result
      ));
    exception when others then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'job_id',coalesce(v_item->>'job_id',''),'status','failed','error',sqlerrm
      ));
    end;
  end loop;

  return v_results;
end;
$function$;

revoke all on function public.recover_reviewed_article_classifications_v1(jsonb) from public, anon, authenticated;
grant execute on function public.recover_reviewed_article_classifications_v1(jsonb) to service_role;