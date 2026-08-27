import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migrationDir = path.join(root, 'supabase', 'migrations');
const migrationName = fs.readdirSync(migrationDir).find((name) => name.endsWith('_lock_verified_pipeline_until_consensus_rollout_v28.sql'));
if (!migrationName) throw new Error('V28 full-rollout gate migration is missing.');
const migration = fs.readFileSync(path.join(migrationDir, migrationName), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'app', 'api', 'internal', 'verified-pipeline-scheduler', 'route.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A. V28 is an explicit static fail-closed gate. The view itself must have no
// passing branch or dependency on mutable canary status.
const viewStart = migration.indexOf('create or replace view public.ocr_consensus_full_rollout_gate_v28');
const viewEnd = migration.indexOf('revoke all on public.ocr_consensus_full_rollout_gate_v28');
assert(viewStart >= 0 && viewEnd > viewStart, 'V28 full-rollout gate view definition must be present.');
const viewDefinition = migration.slice(viewStart, viewEnd);
assert(viewDefinition.includes('with (security_invoker = true)'), 'V28 full-rollout gate must be security invoker.');
assert(viewDefinition.includes("'blocked_pre_rollout'::text as rollout_gate"), 'V28 gate must be statically blocked before rollout implementation.');
assert(viewDefinition.includes('canary comparison is not a rollout completion receipt'), 'V28 gate reason must distinguish canary comparison from rollout completion.');
assert(viewDefinition.includes('null::uuid as release_receipt_id'), 'V28 pre-rollout gate must not invent a release receipt.');
assert(viewDefinition.includes('null::uuid as cohort_id'), 'V28 pre-rollout gate must not promote a canary cohort into a rollout receipt.');
assert(!/'passed'::text\s+as\s+rollout_gate/i.test(viewDefinition), 'V28 static pre-rollout view must have no passing state.');
assert(!/ocr_consensus_jobs_v11|ocr_consensus_canary_cohorts_v26|ocr_canary_method_comparison_v19|ocr_canary_fidelity_v22/i.test(viewDefinition), 'V28 static gate must not infer release from canary/job state.');
assert(/revoke all on public\.ocr_consensus_full_rollout_gate_v28 from public,anon,authenticated;/i.test(migration), 'V28 rollout gate must remain internal.');
assert(/grant select on public\.ocr_consensus_full_rollout_gate_v28 to postgres,service_role;/i.test(migration), 'V28 rollout gate must be readable only by trusted server roles.');

// B. The database post-OCR drain must consult V28 before any legacy OCR gate or
// scheduler request. A legacy ocr_verification_gate_v2=passed cannot bypass V28.
const drainStart = migration.indexOf('create or replace function public.drain_verified_pipeline_after_ocr_v2');
assert(drainStart >= 0, 'V28 must replace the post-OCR drain.');
const drain = migration.slice(drainStart);
for (const invariant of [
  'public.ocr_consensus_full_rollout_gate_v28',
  "v_consensus_rollout_gate is distinct from 'passed'",
  "'reason','ocr_consensus_full_rollout_gate_v28'",
  'strict_system_safety_audit_v24',
  'ocr_verification_gate_v2',
  'request_verified_pipeline_scheduler_tick_v1()'
]) {
  assert(drain.includes(invariant), `V28 post-OCR drain invariant missing: ${invariant}`);
}
assert(
  drain.indexOf('public.ocr_consensus_full_rollout_gate_v28') < drain.indexOf('strict_system_safety_audit_v24'),
  'V28 gate must be checked before system/downstream gates.'
);
assert(
  drain.indexOf('public.ocr_consensus_full_rollout_gate_v28') < drain.indexOf('ocr_verification_gate_v2'),
  'V28 gate must be checked before the production-only legacy OCR gate.'
);
assert(
  drain.indexOf("v_consensus_rollout_gate is distinct from 'passed'") < drain.indexOf('request_verified_pipeline_scheduler_tick_v1()'),
  'V28 gate must block before any scheduler request.'
);

// C. The HTTP scheduler must independently fail closed before it starts the old
// OCR verification lane. This protects manual/direct scheduler POSTs as well as cron.
for (const invariant of [
  'async function currentOcrConsensusFullRolloutGate()',
  ".from('ocr_consensus_full_rollout_gate_v28')",
  ".select('rollout_gate,reason,release_receipt_id,cohort_id')",
  'const ocrConsensusRollout = await currentOcrConsensusFullRolloutGate();',
  "trace.push({ stage: 'ocr_consensus_full_rollout_gate', result: ocrConsensusRollout });",
  "if (ocrConsensusRollout.rollout_gate !== 'passed')",
  "blocked_at: 'ocr_consensus_full_rollout'",
  "runWorkerBatch('ocr_verification'"
]) {
  assert(scheduler.includes(invariant), `V28 scheduler invariant missing: ${invariant}`);
}
assert(
  scheduler.indexOf('const ocrConsensusRollout = await currentOcrConsensusFullRolloutGate();') < scheduler.indexOf("runWorkerBatch('ocr_verification'"),
  'Scheduler must check V28 before starting the legacy OCR verification lane.'
);
assert(
  scheduler.indexOf("if (ocrConsensusRollout.rollout_gate !== 'passed')") < scheduler.indexOf("runWorkerBatch('ocr_verification'"),
  'Scheduler V28 fail-closed branch must occur before any OCR worker execution.'
);

// D. No current repository migration may replace V28 with a passing gate. That is a
// future release operation and must be introduced explicitly with full rollout DDL.
const v28Definitions = [];
for (const name of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  const text = fs.readFileSync(path.join(migrationDir, name), 'utf8');
  if (text.includes('create or replace view public.ocr_consensus_full_rollout_gate_v28')) {
    v28Definitions.push({ name, text });
  }
}
assert(v28Definitions.length === 1, `Exactly one V28 rollout gate definition is allowed before release; found ${v28Definitions.length}.`);
const onlyDefinition = v28Definitions[0].text;
const onlyStart = onlyDefinition.indexOf('create or replace view public.ocr_consensus_full_rollout_gate_v28');
const onlyEnd = onlyDefinition.indexOf('revoke all on public.ocr_consensus_full_rollout_gate_v28');
assert(!/'passed'::text\s+as\s+rollout_gate/i.test(onlyDefinition.slice(onlyStart, onlyEnd)), 'Repository must not contain a passing V28 rollout gate before an explicit release migration.');

console.log('verify-ocr-full-rollout-gate-v28: ok (static pre-rollout block, DB drain guard, runtime scheduler guard, no canary-to-release inference)');
