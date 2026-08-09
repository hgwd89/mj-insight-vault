do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname in ('mj_report_worker','mj-vercel-status-poll-v1','mj-classification-loop-v1') loop
    perform cron.alter_job(r.jobid, active => false);
  end loop;

  update public.chat_jobs
  set status='failed',
      stage='legacy pipeline quarantined',
      error_message='legacy_orphan_quarantined_pending_strict_v6',
      finished_at=coalesce(finished_at,now()),
      lease_token=null,
      lease_expires_at=null,
      next_retry_at=null,
      updated_at=now()
  where status='queued'
    and created_at < timestamptz '2026-07-01 00:00:00+00';
end $$;