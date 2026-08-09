begin;
create table public.verified_theme_analysis_proof_receipts_v8(
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  census_receipt_id uuid not null unique references public.verified_theme_census_receipts_v8(id) on delete cascade,
  candidate_count integer not null check(candidate_count>=0),
  metrics_fingerprint text not null check(metrics_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_fingerprint text not null check(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.verified_theme_analysis_proof_receipts_v8 enable row level security;
revoke all on public.verified_theme_analysis_proof_receipts_v8 from public,anon,authenticated,service_role;
grant select on public.verified_theme_analysis_proof_receipts_v8 to service_role;

create or replace function public.record_verified_theme_analysis_proof_v8()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare v_census uuid;v_run uuid;v_candidates integer;v_metrics text;v_evidence text;v_id uuid;
begin
  if (select census_gate from public.verified_theme_census_gate_v7)<>'passed' then raise exception 'verified_theme_proof_v8_census_required'; end if;
  v_census:=public.record_verified_theme_census_receipt_v8();
  select analysis_run_id,candidate_count into v_run,v_candidates from public.verified_theme_census_receipts_v8 where id=v_census;
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    m.candidate_id::text||':'||m.support_article_count::text||':'||m.avg_mapping_confidence::text||':'||m.support_ratio::text||':'||m.active_month_count::text||':'||coalesce(m.first_active_month,'')||':'||coalesce(m.last_active_month,'')||':'||m.peak_monthly_penetration::text||':'||m.penetration_trend_slope::text
  ,'|' order by m.candidate_id::text),''),'UTF8'),'sha256'),'hex') into v_metrics from public.verified_theme_metrics_v8 m;
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    e.candidate_id::text||':'||e.article_id::text||':'||coalesce(e.article_date,'')||':'||e.mapping_confidence::text||':'||e.mapper_source_anchor||':'||e.critic_source_anchor||':'||array_to_string(e.evidence_roles,',')
  ,'|' order by e.candidate_id::text,e.article_id::text),''),'UTF8'),'sha256'),'hex') into v_evidence from public.verified_theme_deterministic_evidence_v8 e;
  insert into public.verified_theme_analysis_proof_receipts_v8(analysis_run_id,census_receipt_id,candidate_count,metrics_fingerprint,evidence_fingerprint)
  values(v_run,v_census,v_candidates,v_metrics,v_evidence)
  on conflict(analysis_run_id) do update set census_receipt_id=excluded.census_receipt_id,candidate_count=excluded.candidate_count,metrics_fingerprint=excluded.metrics_fingerprint,evidence_fingerprint=excluded.evidence_fingerprint,created_at=now()
  returning id into v_id;
  update public.verified_theme_analysis_runs_v7 set status='ranked',error_message=null,updated_at=now() where id=v_run;
  return v_id;
end
$function$;
revoke all on function public.record_verified_theme_analysis_proof_v8() from public,anon,authenticated;
grant execute on function public.record_verified_theme_analysis_proof_v8() to service_role;

create view public.current_verified_theme_analysis_proof_v8
with (security_invoker=true)
as
select p.* from public.verified_theme_analysis_proof_receipts_v8 p join public.current_verified_theme_census_receipt_v8 c on c.id=p.census_receipt_id and c.analysis_run_id=p.analysis_run_id and c.candidate_count=p.candidate_count join public.verified_theme_analysis_runs_v7 a on a.id=p.analysis_run_id and a.status='ranked' order by p.created_at desc limit 1;
revoke all on public.current_verified_theme_analysis_proof_v8 from public,anon,authenticated;
grant select on public.current_verified_theme_analysis_proof_v8 to service_role;

create view public.verified_theme_analysis_gate_v8
with (security_invoker=true)
as
select p.id proof_receipt_id,p.analysis_run_id,p.candidate_count,p.metrics_fingerprint,p.evidence_fingerprint,'passed'::text analysis_gate,'passed'::text gate_reason from public.current_verified_theme_analysis_proof_v8 p
union all
select null::uuid,null::uuid,0::integer,null::text,null::text,'failed'::text,'verified_theme_analysis_proof_required'::text where not exists(select 1 from public.current_verified_theme_analysis_proof_v8);
revoke all on public.verified_theme_analysis_gate_v8 from public,anon,authenticated;
grant select on public.verified_theme_analysis_gate_v8 to service_role;
commit;