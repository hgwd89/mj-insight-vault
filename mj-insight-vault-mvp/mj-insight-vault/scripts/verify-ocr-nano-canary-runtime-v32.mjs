import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const migration = read('supabase/migrations/20260827160000_scope_nano_v18_canary_runtime_v32.sql');
const route = read('app/api/internal/ocr-consensus-piece-v18/route.ts');
const worker = read('lib/ocrConsensusPieceWorkerV18.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(migration.includes('ocr_consensus_canary_runtime_v32'), 'v32 runtime binding table missing');
assert(migration.includes('cohort_id uuid not null references public.ocr_consensus_canary_cohorts_v26'), 'v32 must bind a durable v26 cohort');
assert(migration.includes("j.id=any(v_job_ids)"), 'claim/drain must scope work to bound job IDs');
assert(migration.includes("j.is_canary is true"), 'claim must remain canary-only');
assert(migration.includes("ocr_consensus_v32_unscoped_active_canary"), 'unscoped active canary must fail closed');
assert(migration.includes("'*/2 * * * *'"), 'Nano canary drain must be throttled to two-minute cadence');
assert(migration.includes('restart_ocr_consensus_canaries_v32'), 'controlled restart wrapper missing');
assert(!migration.includes('drain_verified_pipeline_after_ocr_v2();'), 'v32 must not schedule downstream drain');
assert(!migration.includes('claim_ocr_consensus_job_v11'), 'v32 must not restore generic/full-rollout claim');

assert(route.includes(".from('ocr_consensus_canary_runtime_v32')"), 'route must require active v32 runtime binding');
assert(route.includes(".eq('is_canary', true)"), 'route preflight must inspect canary jobs only');
assert(route.includes(".in('status', ['queued', 'running'])"), 'route preflight must scope active jobs');
assert(route.includes('runOcrConsensusPieceV18Step()'), 'route must execute only the v18 canary worker');
assert(route.includes('full_rollout_execution: false'), 'route must explicitly keep full rollout disabled');
assert(!route.includes('Promise.all(['), 'Nano route must not launch parallel worker steps per request');

assert(worker.includes("rpc('claim_ocr_consensus_canary_v16'"), 'v18 worker must use canary-only claim RPC');
assert(!worker.includes("rpc('claim_ocr_consensus_job_v11'"), 'v18 worker must never use generic claim RPC');
assert(worker.includes('You receive exactly ONE block-local reading-piece image.'), 'piece isolation prompt invariant missing');
assert(worker.includes('If any character position is genuinely unreadable or clipped, output 〓'), 'unreadable glyph policy missing');
assert(!worker.includes('google_text: input.article.google_text'), 'Google OCR must not be inserted into model input metadata');

console.log('verify-ocr-nano-canary-runtime-v32: passed');
