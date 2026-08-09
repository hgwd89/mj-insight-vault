do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='mj-classification-loop-v1' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
end $$;

select cron.schedule(
  'mj-classification-loop-v1',
  '30 seconds',
  'select public.kick_article_classification_loop_v1();'
);