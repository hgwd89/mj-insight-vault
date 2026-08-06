import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260806142000_recompute_formal_proof_in_database.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/full_corpus_run_integrity_v1/.test(sql), 'Database must recompute scan-run integrity.');
assert(/report_raw_evidence_integrity_v1/.test(sql), 'Database must recompute raw evidence integrity.');
assert(/prompt_version <> 'full_corpus_batch_v2'/.test(sql), 'Legacy scan prompt versions must fail.');
assert(/read_article_ids/.test(sql) && /array\(/.test(sql), 'Exact batch read IDs must be compared.');
assert(/formal_corpus_articles_v1/.test(sql), 'Evidence IDs must resolve to formal article records.');
assert(/synthetic_repair/.test(sql), 'Synthetic display repairs must not count as raw proof.');
for (const required of ['refutation_audit', 'research_needs', 'negative_space', 'confidence_rubric']) {
  assert(sql.includes(required), `Raw formal proof must require ${required}.`);
}
assert(/new\.source_job_id is not null/.test(sql), 'Formal reports must be linked to a durable source job.');
assert(/formal_report_run_integrity_failed/.test(sql), 'Invalid persisted runs must block formal inserts.');
assert(/formal_report_raw_evidence_integrity_failed/.test(sql), 'Invalid raw evidence must block formal inserts.');
assert(!/quality_status = 'passed'\s*;/.test(sql), 'Application quality status alone must never determine formal classification.');

console.log('verify-db-formal-proof: ok');
