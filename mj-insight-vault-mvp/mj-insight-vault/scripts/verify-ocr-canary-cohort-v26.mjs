import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migrationPath = path.join(root, 'supabase', 'migrations', '20260827023000_add_ocr_canary_cohort_receipts_v26.sql');
const readoutPath = path.join(root, 'scripts', 'sql', 'ocr-canary-cohort-readout-v26.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const readout = fs.readFileSync(readoutPath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const invariant of [
  'ocr_consensus_canary_cohorts_v26',
  'job_id_1 uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict',
  'job_id_2 uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict',
  'restart_archive_id_1 uuid not null references public.ocr_consensus_requeue_archives_v12(id) on delete restrict',
  'restart_archive_id_2 uuid not null references public.ocr_consensus_requeue_archives_v12(id) on delete restrict',
  'job_id_1::text < job_id_2::text',
  'unique (restart_archive_id_1, restart_archive_id_2)',
  'register_ocr_consensus_canary_cohort_v26',
  'cardinality(p_job_ids)',
  'cardinality(p_archive_ids)',
  "format('v21/v2 clean restart: %s', v_reason)",
  'a.id = x.archive_id',
  'a.job_id = x.job_id',
  'a.reason = v_expected_archive_reason',
  'v_archive_ids:=array_append',
  "(v_requeue->>'archive_id')::uuid",
  'select public.register_ocr_consensus_canary_cohort_v26(',
  "'cohort',v_cohort",
  'revoke all on function public.register_ocr_consensus_canary_cohort_v26(uuid[],uuid[],text) from public,anon,authenticated',
  'grant execute on function public.register_ocr_consensus_canary_cohort_v26(uuid[],uuid[],text) to postgres,service_role'
]) {
  assert(migration.includes(invariant), `V26 cohort migration invariant missing: ${invariant}`);
}

assert(/if\s+coalesce\(cardinality\(p_job_ids\),0\)\s*<>\s*2/i.test(migration), 'Cohort registration must require exactly two jobs.');
assert(/if\s+coalesce\(cardinality\(p_archive_ids\),0\)\s*<>\s*2/i.test(migration), 'Cohort registration must require exactly two archives.');
assert(/where\s+j\.id\s+in\s*\(v_job_a,v_job_b\)[\s\S]*?j\.is_canary\s+is\s+true/i.test(migration), 'Cohort registration must validate both jobs are marked canaries.');
assert(/if\s+v_job_a::text\s*<\s*v_job_b::text/i.test(migration), 'Cohort registration must canonicalize pair ordering by job ID.');
assert(/restart_ocr_consensus_canaries_v21_v22[\s\S]*?requeue_ocr_consensus_canary_v12[\s\S]*?array_append\(v_archive_ids,[\s\S]*?register_ocr_consensus_canary_cohort_v26/i.test(migration), 'Atomic restart must capture actual requeue archive IDs before cohort registration.');
assert(!/order\s+by\s+.*(?:job|updated_at|finished_at).*limit\s+2/i.test(migration), 'Cohort identity must never use a latest-two job heuristic.');

const withoutComments = readout.replace(/^\s*--.*$/gm, '');
assert(/^\s*with\b/i.test(withoutComments), 'V26 cohort readout must start with a read-only CTE statement.');
assert((withoutComments.match(/;/g) || []).length === 1, 'V26 cohort readout must remain a single statement.');
assert(!/\b(insert|update|delete|alter|drop|truncate|grant|revoke|call|copy|do|create)\b/i.test(withoutComments), 'V26 cohort readout must never mutate production.');

for (const invariant of [
  'latest_cohort as',
  'public.ocr_consensus_canary_cohorts_v26',
  'order by c.created_at desc,c.id desc',
  'limit 1',
  'cohort_job_ids',
  'archive_bindings',
  "format('v21/v2 clean restart: %s',c.reason)",
  'binding_valid',
  'ocr_consensus_jobs_v11',
  'ocr_independent_segment_receipts_v16',
  'ocr_independent_transcriptions_v11',
  'ocr_consensus_decisions_v11',
  'article_ocr_verifications_v11',
  'ocr_canary_method_comparison_v19',
  'ocr_canary_fidelity_v22',
  "'expected_latest_cohort_job_count',2",
  "'latest_cohort_job_count'",
  "'latest_cohort_terminal_job_count'",
  "'latest_cohort_failed_job_count'",
  "'latest_cohort_archive_binding_valid'",
  "'latest_cohort_ready_for_comparison'",
  "'method_comparison_v19_all_marked'",
  "'fidelity_v22_all_marked'",
  'lease_token is not null as has_lease_token'
]) {
  assert(readout.includes(invariant), `V26 cohort readout invariant missing: ${invariant}`);
}

assert(/cohort_job_ids\s+as\s*\([\s\S]*?job_id_1[\s\S]*?union\s+all[\s\S]*?job_id_2/i.test(readout), 'Latest cohort job scope must come from the durable receipt pair.');
assert(/'method_comparison_v19'[\s\S]*?where\s+c\.consensus_job_id\s+in\s*\(select\s+job_id\s+from\s+cohort_job_ids\)/i.test(readout), 'Default method comparison must be exact-cohort scoped.');
assert(/'fidelity_v22'[\s\S]*?where\s+f\.consensus_job_id\s+in\s*\(select\s+job_id\s+from\s+cohort_job_ids\)/i.test(readout), 'Default fidelity comparison must be exact-cohort scoped.');
assert(!/order\s+by\s+j\.(?:created_at|updated_at|finished_at)[\s\S]*?limit\s+2/i.test(readout), 'Readout must not infer cohort identity from latest two jobs.');
assert(!/cohort_jobs\s+as\s*\(\s*select\s+\*/is.test(readout), 'Cohort job projection must remain sanitized.');
const jobProjection = readout.match(/cohort_jobs\s+as\s*\((.*?)\)\s*,\s*archive_bindings/is)?.[1] || '';
assert(jobProjection.length > 0, 'Cohort job projection must be parseable.');
assert(!/\blease_token\s*(?:,|\bas\b)/i.test(jobProjection), 'Cohort readout must not expose raw lease tokens.');
assert(/\blease_token\s+is\s+not\s+null\s+as\s+has_lease_token\b/i.test(jobProjection), 'Cohort readout may expose only lease-token presence.');

console.log('verify-ocr-canary-cohort-v26: ok (durable exact-two cohort receipt, archive binding, atomic restart registration, read-only scoped comparison)');
