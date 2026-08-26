import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/ocrConsensusPieceWorkerV18.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'lib/articleBlockReadingV17.ts'), 'utf8');
const readingV21 = fs.readFileSync(path.join(root, 'lib/articleBlockReadingV21.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/ocr-consensus-piece-v18/route.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826103000_add_block_local_piece_receipts_v18.sql'), 'utf8');
const bindingMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826162500_harden_v21_piece_receipt_binding.sql'), 'utf8');

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

// V21 must split extremely tall/narrow OCR blocks on horizontal low-ink gaps.
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
assert((route.match(/runOcrConsensusPieceV18Step\(\)/g) || []).length === 2, 'Route source must contain exactly two parallel worker slots.');
assert(!route.includes('for (let round = 0; round < 2; round += 1)'), 'Route must not run a second sequential round inside one Vercel request.');
assert(route.includes('const rounds = [await Promise.all(['), 'Route must run exactly one two-worker parallel round per request.');
assert(route.includes('async function assertNoLegacyCanaryPieceReceipts()'), 'Route must preflight persisted canary pieces before any worker call.');
assert(route.indexOf('await assertNoLegacyCanaryPieceReceipts()') < route.indexOf('runOcrConsensusPieceV18Step()'), 'Legacy receipt preflight must run before the first external OCR worker can start.');
assert(route.includes('ARTICLE_BLOCK_READING_VERSION_V21'), 'Route preflight must compare persisted receipts to the canonical V21 version constant.');
assert(route.includes(".select('job_id,segmentation_version')"), 'Route preflight must inspect persisted segmentation versions.');
assert(route.includes('Archive/requeue the canaries before resuming.'), 'Legacy receipt failure must direct operators to archive/requeue rather than silently resume.');

for (const invariant of [
  "'whole_block','vertical_segment','vertical_band','vertical_segment_band'",
  'ocr_consensus_v21_segmentation_version_changed_within_article_pass',
  'ocr_consensus_v21_segmentation_spec_changed_within_article_pass',
  'ocr_consensus_v21_piece_count_changed_within_article_pass'
]) {
  assert(bindingMigration.includes(invariant), `V21 DB piece-binding invariant missing: ${invariant}`);
}
assert(!bindingMigration.includes('decide_ocr_consensus_article_v11'), 'V21 binding hardening must not alter v11 consensus thresholds.');

console.log('verify-ocr-piece-v18: ok');
