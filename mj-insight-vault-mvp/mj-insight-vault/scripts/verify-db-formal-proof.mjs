import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260806142000_recompute_formal_proof_in_database.sql'), 'utf8');
const noSignal = fs.readFileSync(path.join(root, 'supabase/migrations/20260806144500_normalize_no_signal_scan_proof.sql'), 'utf8');
const dedupe = fs.readFileSync(path.join(root, 'supabase/migrations/20260806152000_deduplicate_formal_corpus.sql'), 'utf8');
const categoryGate = fs.readFileSync(path.join(root, 'supabase/migrations/20260806154500_block_incomplete_category_reports.sql'), 'utf8');

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

assert(/accept_validated_no_signal_scan_batch/.test(noSignal), 'Evidence-bearing no-signal batches need an explicit compatibility contract.');
assert(/model_reported_read_article_ids/.test(noSignal), 'Model-reported IDs must be retained for audit.');
assert(/\{read_article_ids\}/.test(noSignal), 'Canonical read IDs must be normalized to server-supplied batch IDs.');
assert(/\{no_signal_detected\}/.test(noSignal), 'No-signal batches must use the canonical integrity flag.');
assert(/no_signal_batch/.test(noSignal), 'Legacy no-signal metadata must remain readable.');
assert(/lower\(coalesce\(new\.summary_json/.test(noSignal), 'Boolean parsing must fail closed without unsafe casts.');
assert(/jsonb_array_length\(case when jsonb_typeof/.test(noSignal), 'JSON arrays must be type-checked before length validation.');

assert(/normalize_article_headline_v1/.test(dedupe), 'Formal duplicates need a shared deterministic identity function.');
assert(/duplicate_of_article_id/.test(dedupe) && /exclusion_reason/.test(dedupe), 'Duplicate rows must remain auditable.');
assert(/text_length desc, c\.has_profile desc, c\.has_embedding desc/.test(dedupe), 'Canonical article selection must be deterministic and quality-biased.');
assert(/status = 'excluded'/.test(dedupe), 'Duplicate rows must be excluded, not physically deleted.');
assert(/cleanup_hidden_article_derivatives/.test(dedupe), 'Hidden articles must not retain search or classification derivatives.');
for (const table of ['article_embeddings', 'article_profiles', 'article_category_memberships', 'article_tags']) {
  assert(dedupe.includes(`delete from public.${table}`), `Hidden article cleanup must include ${table}.`);
}
assert(/articles_active_date_normalized_headline_uidx/.test(dedupe), 'Future duplicate article inserts must be rejected by a unique partial index.');
assert(/article_duplicate_audit_v1/.test(dedupe), 'Duplicate decisions must remain queryable for audit.');
assert(/update public\.monthly_rollups/.test(dedupe) && /status = 'stale'/.test(dedupe), 'Duplicate removal must invalidate affected rollups.');

assert(/category_classification_gate_v1/.test(categoryGate), 'Category formal reports need a classification coverage gate.');
assert(/unprofiled_article_count/.test(categoryGate), 'Category gate must count missing article profiles.');
assert(/uncategorized_article_count/.test(categoryGate), 'Category gate must count missing category memberships.');
assert(/invalid_membership_count/.test(categoryGate), 'Category gate must reject inactive or missing categories.');
assert(/category_classification_/.test(categoryGate) && /corpus_scan_gate_view/.test(categoryGate), 'Category coverage must fail the shared corpus gate before generation.');
assert(/formal_category_classification_incomplete/.test(categoryGate), 'Database must reject a category report when global classification is incomplete.');
assert(/formal_category_id_invalid/.test(categoryGate), 'Database must reject inactive or unknown category IDs.');
assert(/trg_00_enforce_category_report_classification_v1/.test(categoryGate), 'Category proof must be enforced before report metadata synchronization.');

console.log('verify-db-formal-proof: ok');