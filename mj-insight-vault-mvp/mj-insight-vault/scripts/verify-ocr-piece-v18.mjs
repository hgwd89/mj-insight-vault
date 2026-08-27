import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/ocrConsensusPieceWorkerV18.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'lib/articleBlockReadingV17.ts'), 'utf8');
const readingV21 = fs.readFileSync(path.join(root, 'lib/articleBlockReadingV21.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/ocr-consensus-piece-v18/route.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826103000_add_block_local_piece_receipts_v18.sql'), 'utf8');
const bindingMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826162500_harden_v21_piece_receipt_binding.sql'), 'utf8');
const restartMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826163000_add_atomic_v21_canary_restart_v22.sql'), 'utf8');
const drainHardeningMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260827022000_harden_v18_canary_drain_failed_state_v25.sql'), 'utf8');

function assert(condition, message) { if (!condition) throw new Error(message); }

const callStart = worker.indexOf('async function callPieceVision');
const callEnd = worker.indexOf('function sanitizePiece');
assert(callStart >= 0 && callEnd > callStart, 'callPieceVision must exist.');
const callFn = worker.slice(callStart, callEnd);
assert(!/google_text/.test(callFn), 'Piece model call must never reference Google OCR text.');
assert(callFn.includes('exactly ONE block-local reading-piece image'), 'Prompt must bind one block-local piece only.');
assert(callFn.includes('do not receive Google OCR, candidate text, article overview, adjacent pieces'), 'Prompt must prohibit external textual context.');
assert(callFn.includes('output 〓 at that position instead of guessing'), 'Prompt must require 〓 for unreadable glyphs.');
assert(callFn.includes('Do not improve Japanese grammar or make the fragment sound natural'), 'Prompt must prohibit natural-language repair.');
assert(callFn.includes('Do not add sentence endings, particles, punctuation'), 'Prompt must prohibit sentence completion.');
assert((callFn.match(/type: 'input_image'/g) || []).length === 1, 'Each model call must contain exactly one input image.');
assert(worker.includes('const PIECE_MAX_OUTPUT_TOKENS = 8_000'), 'Piece output budget must remain large enough for GPT-5.6 structured output after reasoning.');
assert(callFn.includes('max_output_tokens: PIECE_MAX_OUTPUT_TOKENS'), 'Piece model call must use the hardened output budget.');
assert(callFn.includes('json.incomplete_details') && callFn.includes('incomplete_reason=') && callFn.includes('output_items='), 'Empty provider output must preserve incomplete-response diagnostics.');
assert(worker.includes('buildArticleBlockReadingPiecesV17'), 'Worker must use the compatibility entrypoint for block-local pieces.');
assert(bridge.includes('buildArticleBlockReadingPiecesV21 as buildArticleBlockReadingPiecesV17'), 'Compatibility entrypoint must route the worker to V21, not legacy V17 segmentation.');
assert(bridge.includes('ARTICLE_BLOCK_READING_VERSION_V21 as ARTICLE_BLOCK_READING_VERSION_V17'), 'Compatibility version export must point to the V21 persisted version.');
assert(readingV21.includes("ARTICLE_BLOCK_READING_VERSION_V21 = 'article_block_local_vertical_segments_v2'"), 'V21 must persist a new segmentation version so v1 receipts cannot mix silently.');

for (const invariant of [
  'TALL_COLUMN_MIN_HEIGHT = 260',
  'TALL_COLUMN_MIN_ASPECT = 4.5',
  'TARGET_BAND_HEIGHT = 175',
  'MIN_BAND_HEIGHT = 72',
  'async function localHorizontalBands',
  'const rowInk = new Array<number>(height).fill(0)',
  "normalizedBest <= Math.max(1, typicalInk * 0.45)",
  "'vertical_band'",
  "'vertical_segment_band'",
  'sourceTop = block.top + part.localTop',
  'sourceBottom = block.top + part.localBottom'
]) {
  assert(readingV21.includes(invariant), `Tall-narrow V21 invariant missing: ${invariant}`);
}
assert(
  readingV21.indexOf('for (const range of orderedXRanges)') < readingV21.indexOf('const yBands = await localHorizontalBands'),
  'V21 must preserve right-to-left column order and split each column top-to-bottom.'
);
assert(
  readingV21.includes('if (!boundaries.length) return [{ top: 0, bottom: height - 1 }]'),
  'V21 must preserve a continuous column when no genuine horizontal gutter is found.'
);

assert(worker.includes("receipts.map((row) => row.transcription).join('\\n')"), 'Article text must be deterministic concatenation only.');
assert(worker.includes('const confidence = Math.min(...receipts.map((row) => row.confidence))'), 'Article confidence must be minimum piece confidence.');
assert(worker.includes("supabaseAdmin.rpc('decide_ocr_consensus_article_v11'"), 'Existing consensus gate must remain the decision function.');
assert(worker.includes("supabaseAdmin.rpc('append_ocr_independent_piece_v18'"), 'Piece-level receipt RPC must be used.');
assert(!migration.includes('decide_ocr_consensus_article_v11'), 'v18 receipt migration must not alter consensus thresholds.');
assert(migration.includes('block_index') && migration.includes('source_left'), 'Piece receipts must retain local geometry provenance.');

assert(route.includes('requireAppPassword(req)'), 'v18 route must remain authenticated.');
assert((route.match(/runOcrConsensusPieceV18Step\(\)/g) || []).length === 1, 'Nano canary route must execute exactly one worker step per HTTP request.');
assert(!route.includes('Promise.all(['), 'Nano canary route must not fan out multiple OCR workers inside one request.');
assert(!route.includes('for (let round = 0; round < 2; round += 1)'), 'Route must not run a second sequential round inside one Vercel request.');
assert(route.includes(".from('ocr_consensus_canary_runtime_v32')"), 'Route must bind execution to the explicit Nano canary runtime.');
assert(route.includes('if (!runtime?.active)'), 'Route must remain paused without an explicitly active canary cohort.');
assert(route.includes('if (allowed.size !== 2)'), 'Route must require an exact two-job canary binding.');
assert(route.includes(".eq('is_canary', true)"), 'Route runtime preflight must inspect canaries only.');
assert(route.includes(".in('status', ['queued', 'running'])"), 'Route runtime preflight must inspect runnable canaries only.');
assert(route.includes('active canary job(s) outside the bound cohort'), 'Route must fail closed on runnable canaries outside the bound cohort.');
assert(route.indexOf('const runtime = await getNanoCanaryRuntime()') < route.indexOf('const result = await runOcrConsensusPieceV18Step()'), 'Runtime scope validation must happen before the OCR worker call.');
assert(route.includes('full_rollout_execution: false'), 'Route must explicitly keep full rollout execution disabled.');

for (const invariant of [
  "'whole_block','vertical_segment','vertical_band','vertical_segment_band'",
  'ocr_consensus_v21_segmentation_version_changed_within_article_pass',
  'ocr_consensus_v21_segmentation_spec_changed_within_article_pass',
  'ocr_consensus_v21_piece_count_changed_within_article_pass'
]) {
  assert(bindingMigration.includes(invariant), `V21 DB piece-binding invariant missing: ${invariant}`);
}
assert(!bindingMigration.includes('decide_ocr_consensus_article_v11'), 'V21 binding hardening must not alter v11 consensus thresholds.');

for (const invariant of [
  'restart_ocr_consensus_canaries_v21_v22',
  'ocr_consensus_v22_exactly_two_jobs_required',
  'ocr_consensus_v22_job_set_not_bijective',
  'ocr_consensus_v22_canary_only',
  'ocr_consensus_v22_active_lease',
  'requeue_ocr_consensus_canary_v12',
  'ocr_consensus_v22_residual_current_evidence',
  "jobname='ocr_consensus_piece_v18_canary_drain'",
  'drain_ocr_consensus_piece_v18_canary_v1',
  'kick_ocr_consensus_piece_canary_v18'
]) {
  assert(restartMigration.includes(invariant), `Atomic V21 canary restart invariant missing: ${invariant}`);
}
assert(restartMigration.includes("j.status not in ('failed','queued','running')"), 'Atomic restart must reject completed or unexpected job states.');
assert(restartMigration.includes('j.failure_count<>0') && restartMigration.includes('j.lease_token is not null'), 'Atomic restart must verify clean queued state after archive/requeue.');
assert(!restartMigration.includes('decide_ocr_consensus_article_v11'), 'Atomic restart must not alter v11 consensus thresholds.');

for (const invariant of [
  "count(*) filter(where status='failed')",
  'v_failed>0',
  "'status','blocked_failed'",
  "'failed',v_failed",
  "jobname='ocr_consensus_piece_v18_canary_drain'",
  "cron.unschedule('ocr_consensus_piece_v18_canary_drain')",
  "jsonb_build_object('status','complete','cron_unscheduled',true,'failed',0)"
]) {
  assert(drainHardeningMigration.includes(invariant), `Canary drain fail-close invariant missing: ${invariant}`);
}
assert(
  drainHardeningMigration.indexOf('if v_failed>0 then') < drainHardeningMigration.indexOf('if v_active=0 then'),
  'Canary drain must distinguish failed canaries before declaring completion.'
);
assert(!drainHardeningMigration.includes('decide_ocr_consensus_article_v11'), 'Canary drain hardening must not alter consensus thresholds.');

console.log('verify-ocr-piece-v18: ok');
