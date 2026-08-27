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
  'has_lease_token',
  'lease_expires_at',
  'lease_state',
  "'active'",
  "'expired'",
  "'none'",
  'current_database()',
  "current_setting('server_version')"
]) {
  assert(sql.includes(invariant), `Recovery readout invariant missing: ${invariant}`);
}

// Do not pin historical canary IDs or a single segmentation version: the whole point
// is to discover authoritative current state and detect legacy/mixed evidence.
assert(!/d7a9cd1d-a2af-4a44-8285-a633e1837dc5/i.test(sql), 'Recovery readout must not pin a historical canary job ID.');
assert(!/e1c8a911-070a-49d7-8439-abd4654a2a43/i.test(sql), 'Recovery readout must not pin a historical canary job ID.');
assert(!/segmentation_version\s*=\s*'article_block_local_vertical_segments_v2'/i.test(sql), 'Recovery readout must expose version drift instead of filtering it away.');

console.log('verify-ocr-canary-recovery-readout-v23: ok (single read-only statement, current canaries only, full recovery evidence)');
