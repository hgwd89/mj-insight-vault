-- The OCR verification gate is expensive to evaluate while the corpus is still incomplete.
-- Polling it every minute adds unnecessary DB load but does not advance OCR itself.
-- Keep the exact same hard gate and downstream scheduler; only reduce the waiting poll cadence.

do $block$
begin
  if exists (
    select 1 from cron.job where jobname = 'mj-verified-pipeline-after-ocr-v2'
  ) then
    perform cron.unschedule('mj-verified-pipeline-after-ocr-v2');
  end if;

  perform cron.schedule(
    'mj-verified-pipeline-after-ocr-v2',
    '*/5 * * * *',
    'select public.drain_verified_pipeline_after_ocr_v2();'
  );
end
$block$;
