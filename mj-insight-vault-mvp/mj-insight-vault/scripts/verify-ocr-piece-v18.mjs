import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/ocrConsensusPieceWorkerV18.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/ocr-consensus-piece-v18/route.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826103000_add_block_local_piece_receipts_v18.sql'), 'utf8');

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
assert(worker.includes('buildArticleBlockReadingPiecesV17'), 'Worker must use block-local reading pieces.');
assert(worker.includes("receipts.map((row) => row.transcription).join('\\n')"), 'Article text must be deterministic concatenation only.');
assert(worker.includes('const confidence = Math.min(...receipts.map((row) => row.confidence))'), 'Article confidence must be minimum piece confidence.');
assert(worker.includes("supabaseAdmin.rpc('decide_ocr_consensus_article_v11'"), 'Existing v11 hard gate must remain the decision function.');
assert(worker.includes("supabaseAdmin.rpc('append_ocr_independent_piece_v18'"), 'Piece-level receipt RPC must be used.');
assert(!migration.includes('decide_ocr_consensus_article_v11'), 'v18 migration must not alter v11 gate thresholds.');
assert(migration.includes('block_index') && migration.includes('source_left'), 'Piece receipts must retain local geometry provenance.');
assert(route.includes('requireAppPassword(req)'), 'v18 route must remain authenticated.');
assert((route.match(/runOcrConsensusPieceV18Step\(\)/g) || []).length === 2, 'Route may run exactly two independent canary workers in parallel.');

console.log('verify-ocr-piece-v18: ok');
