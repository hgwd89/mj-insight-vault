begin;

-- The original v11 generic claim can select non-canary jobs.  There is no approved
-- full-corpus V21 rollout yet, so retire that claim at the database boundary rather
-- than relying only on retired HTTP routes.  Future rollout must introduce a new,
-- explicitly gated claim tied to an approved canary cohort/release receipt.
create or replace function public.claim_ocr_consensus_job_v11(p_lease_seconds integer default 360)
returns table(id uuid,source_job_id uuid,article_count integer,is_canary boolean,lease_token uuid)
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  raise exception 'ocr_consensus_v11_generic_claim_retired';
  return;
end
$function$;

revoke all on function public.claim_ocr_consensus_job_v11(integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_ocr_consensus_job_v11(integer) to postgres;

-- Keep the old drain-compatible kick name, but make it delegate to the newer
-- guarded canary kick.  The guarded function refuses to run while any non-canary
-- OCR consensus job is queued/running, so the legacy alias cannot bypass that lock.
create or replace function public.kick_ocr_consensus_piece_v18_canary_v1()
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_result jsonb;
  v_status text;
  v_request_id bigint;
begin
  select public.kick_ocr_consensus_piece_canary_v18() into v_result;
  v_status := coalesce(v_result->>'status','');

  if v_status = 'idle' then
    return null;
  end if;
  if v_status <> 'kicked' then
    raise exception 'ocr_consensus_piece_v18_guarded_kick_unexpected_status:%',v_status;
  end if;

  v_request_id := nullif(v_result->>'request_id','')::bigint;
  if v_request_id is null then
    raise exception 'ocr_consensus_piece_v18_guarded_kick_missing_request_id';
  end if;
  return v_request_id;
end
$function$;

revoke all on function public.kick_ocr_consensus_piece_v18_canary_v1() from public,anon,authenticated;
grant execute on function public.kick_ocr_consensus_piece_v18_canary_v1() to postgres,service_role;

commit;
