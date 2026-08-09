do $$
declare
  r record;
begin
  for r in
    select jobid
    from cron.job
    where command = 'select public.kick_active_v2_corpus_scan_v1();'
      and active
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end
$$;