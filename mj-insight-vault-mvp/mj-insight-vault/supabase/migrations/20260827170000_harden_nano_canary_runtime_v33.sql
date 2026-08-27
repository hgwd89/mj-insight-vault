begin;

-- Harden the v32 Nano OCR canary runtime so the durable cohort binding cannot be
-- mutated directly by application service-role code. Runtime activation/restart
-- must go through the SECURITY DEFINER control functions, which validate the
-- exact v26 cohort and two-job canary scope before changing this singleton.
revoke insert, update, delete on table public.ocr_consensus_canary_runtime_v32 from service_role;
grant select on table public.ocr_consensus_canary_runtime_v32 to service_role;

-- Owner/postgres retains control for the SECURITY DEFINER functions.
grant select, insert, update, delete on table public.ocr_consensus_canary_runtime_v32 to postgres;

comment on table public.ocr_consensus_canary_runtime_v32 is
  'Singleton runtime binding for one exact two-job OCR canary cohort. service_role is read-only; writes must use validated SECURITY DEFINER activation/restart functions. It never authorizes non-canary/full-rollout work.';

commit;
