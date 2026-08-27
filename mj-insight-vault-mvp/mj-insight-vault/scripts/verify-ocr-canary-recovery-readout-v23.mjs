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
  "'expected_canary_job_count', 2",
  'canary_cardinality_matches_expected',
  'canary_cardinality_status',
  "'expected_two'",
  "'unexpected_count'",
  'current_database()',
  "current_setting('server_version')"
]) {
  assert(sql.includes(invariant), `Recovery readout invariant missing: ${invariant}`);
}

// The readout may expose whether a lease exists, but never the lease token itself.
// canary_jobs is serialized wholesale below, so its projection must be explicitly
// sanitized rather than SELECT * from ocr_consensus_jobs_v11.
assert(!/canary_jobs\s+as\s*\(\s*select\s+\*/is.test(sql), 'Recovery readout must not serialize raw OCR consensus job rows.');
const canaryProjection = sql.match(/canary_jobs\s+as\s*\((.*?)\)\s*,\s*canary_ids/is)?.[1] || '';
assert(canaryProjection.length > 0, 'Recovery readout canary_jobs projection must be parseable.');
assert(!/\blease_token\s*(?:,|\bas\b)/i.test(canaryProjection), 'Recovery readout must not project the raw lease token.');
assert(/\blease_token\s+is\s+not\s+null\s+as\s+has_lease_token\b/i.test(canaryProjection), 'Recovery readout must expose only lease-token presence.');

// Do not pin historical canary IDs or a single segmentation version: the whole point
// is to discover authoritative marked-canary state and detect stale/mixed evidence.
// Cardinality is reported separately and must visibly fail closed when it is not two.
assert(!/d7a9cd1d-a2af-4a44-8285-a633e1837dc5/i.test(sql), 'Recovery readout must not pin a historical canary job ID.');
assert(!/e1c8a911-070a-49d7-8439-abd4654a2a43/i.test(sql), 'Recovery readout must not pin a historical canary job ID.');
assert(!/segmentation_version\s*=\s*'article_block_local_vertical_segments_v2'/i.test(sql), 'Recovery readout must expose version drift instead of filtering it away.');

console.log('verify-ocr-canary-recovery-readout-v23: ok (read-only, lease-token redacted, cardinality guard, full recovery evidence)');
