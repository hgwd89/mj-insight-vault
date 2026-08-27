-- Nano-safe operating mode for the free Supabase compute tier.
--
-- Goal: keep new source-image storage and explicit one-at-a-time OCR usable while preventing
-- the historical OCR canary and verified downstream pipeline from continuously consuming
-- database CPU / memory / I/O. This migration does not delete data, mutate proof lineage,
-- lower any quality gate, or authorize the 538-page full OCR rollout.
--
-- Full downstream processing remains recoverable by explicit future migrations/operations.

do $block$
begin
  if exists (
    select 1 from cron.job where jobname = 'ocr_consensus_piece_v18_canary_drain'
  ) then
    perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
  end if;

  if exists (
    select 1 from cron.job where jobname = 'mj-verified-pipeline-after-ocr-v2'
  ) then
    perform cron.unschedule('mj-verified-pipeline-after-ocr-v2');
  end if;
end
$block$;

comment on function public.drain_ocr_consensus_piece_v18_canary_v1() is
  'Historical OCR canary drain retained for provenance/recovery but unscheduled in Nano stock+OCR-only mode.';

comment on function public.drain_verified_pipeline_after_ocr_v2() is
  'Verified downstream drain retained but unscheduled in Nano stock+OCR-only mode; hard gates remain unchanged.';
