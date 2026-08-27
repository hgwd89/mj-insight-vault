import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sqlPath = path.join(root, 'scripts', 'sql', 'ocr-canary-recovery-readout-v23.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const withoutComments = sql.replace(/^\s*--.*$/gm, '');

// Recovery inspection must remain a single read-only statement. It is deliberately
// safe to run before deciding whether to preserve V21 evidence or clean-restart it.
assert(/^\s*with\b/i.test(withoutComments), 'Recovery readout must start with a read-only CTE statement.');
assert((withoutComments.match(/;/g) || []).length === 1, 'Recovery readout must remain a single statement.');
assert(!/\b(insert|update|delete|alter|drop|truncate|grant|revoke|call|copy|do|create)\b/i.test(withoutComments), 'Recovery readout must never mutate production.');

for (const invariant of [
  'where is_canary is true',
  'recovery_candidate_jobs',
  'recovery_candidate_ids',
  "where status in ('failed','queued','running')",
  'ocr_consensus_jobs_v11',
  'ocr_independent_segment_receipts_v16',
  'ocr_independent_transcriptions_v11',
  'ocr_consensus_decisions_v11',
  'article_ocr_verifications_v11',
  'ocr_canary_method_comparison_v19',
  'ocr_canary_fidelity_v22',
  'ocr_verification_gate_v2',
  'ocr_region_provenance_quality_v19',
  'ocr_consensus_requeue_archives_v12',
  'ocr_consensus_resume_receipts_v19',
  'segmentation_version',
  'failed_output_contracts',
  'failed_proper_noun_checks',
  'receipts_with_unreadable_marker',
  'lease_summary',
  'lease_token is not null as has_lease_token',
  'has_lease_token',
  'lease_expires_at',
  'lease_state',
  "'active'",
  "'expired'",
  "'none'",
  "'all_canary_job_count'",
  "'terminal_canary_job_count'",
  "'expected_recovery_candidate_job_count', 2",
  "'recovery_candidate_job_count'",
  'recovery_candidate_cardinality_matches_expected',
  'recovery_candidate_cardinality_status',
  "'expected_two'",
  "'no_recovery_candidates'",
  "'unexpected_count'",
  "'method_comparison_v19_all_marked'",
  "'fidelity_v22_all_marked'",
  'current_database()',
  "current_setting('server_version')"
]) {
  assert(sql.includes(invariant), `Recovery readout invariant missing: ${invariant}`);
}

// The recovery candidate predicate must match the statuses accepted by the controlled
// resume/restart paths, rather than counting terminal historical canaries as blockers.
assert(/recovery_candidate_jobs\s+as\s*\([\s\S]*?from\s+canary_jobs[\s\S]*?where\s+status\s+in\s*\(\s*'failed'\s*,\s*'queued'\s*,\s*'running'\s*\)/i.test(sql), 'Recovery candidates must be failed/queued/running marked canaries.');
assert(/recovery_candidate_ids\s+as\s*\([\s\S]*?select\s+id\s+from\s+recovery_candidate_jobs/i.test(sql), 'Recovery evidence must have an explicit recovery-candidate ID set.');
assert(/recovery_candidate_cardinality_matches_expected'[\s\S]*?count\(\*\)\s+from\s+recovery_candidate_jobs\)\s*=\s*2/i.test(sql), 'Recovery cardinality must be computed from recovery candidates, not all canary history.');
assert(!sql.includes("'expected_canary_job_count'"), 'Recovery readout must not imply all historical marked canaries must total exactly two.');
assert(!sql.includes("'canary_cardinality_matches_expected'"), 'Recovery readout must not gate on all historical marked canaries.');

// Every mutable-current evidence CTE used for the recovery decision must be scoped to
// recovery candidates. Historical marked canaries remain visible only in explicit
// all-marked audit arrays so they cannot silently contaminate the recovery decision.
for (const cte of ['piece_summary','transcription_summary','decision_rows','canonical_rows','requeue_rows','resume_rows']) {
  const nextCte = cte === 'resume_rows' ? '\\)\\s*select\\s+jsonb_build_object' : '\\)\\s*,';
  const match = sql.match(new RegExp(`${cte}\\s+as\\s*\\(([\\s\\S]*?)${nextCte}`, 'i'));
  assert(match?.[1]?.includes('recovery_candidate_ids'), `${cte} must be scoped to recovery_candidate_ids.`);
  assert(!match?.[1]?.includes('canary_ids'), `${cte} must not use an all-canary ID set.`);
}
assert(/from\s+recovery_candidate_jobs\s+j/i.test(sql), 'Lease summary must be scoped to recovery candidates.');
assert(/'method_comparison_v19'[\s\S]*?ocr_canary_method_comparison_v19\s+c[\s\S]*?where\s+c\.consensus_job_id\s+in\s*\(select\s+id\s+from\s+recovery_candidate_ids\)/i.test(sql), 'Default method comparison must be recovery-candidate scoped.');
assert(/'fidelity_v22'[\s\S]*?ocr_canary_fidelity_v22\s+f[\s\S]*?where\s+f\.consensus_job_id\s+in\s*\(select\s+id\s+from\s+recovery_candidate_ids\)/i.test(sql), 'Default fidelity readout must be recovery-candidate scoped.');
assert(/'method_comparison_v19_all_marked'[\s\S]*?ocr_canary_method_comparison_v19\s+c/i.test(sql), 'All-marked method comparison audit must remain available.');
assert(/'fidelity_v22_all_marked'[\s\S]*?ocr_canary_fidelity_v22\s+f/i.test(sql), 'All-marked fidelity audit must remain available.');

// The readout may expose whether a lease exists, but never the lease token itself.
// canary_jobs is serialized wholesale below, so its projection must be explicitly
// sanitized rather than SELECT * from ocr_consensus_jobs_v11.
assert(!/canary_jobs\s+as\s*\(\s*select\s+\*/is.test(sql), 'Recovery readout must not serialize raw OCR consensus job rows.');
const canaryProjection = sql.match(/canary_jobs\s+as\s*\((.*?)\)\s*,\s*recovery_candidate_jobs/is)?.[1] || '';
assert(canaryProjection.length > 0, 'Recovery readout canary_jobs projection must be parseable.');
assert(!/\blease_token\s*(?:,|\bas\b)/i.test(canaryProjection), 'Recovery readout must not project the raw lease token.');
assert(/\blease_token\s+is\s+not\s+null\s+as\s+has_lease_token\b/i.test(canaryProjection), 'Recovery readout must expose only lease-token presence.');

// Do not pin historical canary IDs or a single segmentation version: the whole point
// is to discover authoritative marked-canary state and detect stale/mixed evidence.
assert(!/d7a9cd1d-a2af-4a44-8285-a633e1837dc5/i.test(sql), 'Recovery readout must not pin a historical canary job ID.');
assert(!/e1c8a911-070a-49d7-8439-abd4654a2a43/i.test(sql), 'Recovery readout must not pin a historical canary job ID.');
assert(!/segmentation_version\s*=\s*'article_block_local_vertical_segments_v2'/i.test(sql), 'Recovery readout must expose version drift instead of filtering it away.');

console.log('verify-ocr-canary-recovery-readout-v23: ok (read-only, lease-token redacted, recovery evidence scoped, all-marked audit preserved)');
