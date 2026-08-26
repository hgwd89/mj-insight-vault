import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/ocrConsensusSegmentWorkerV16.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/ocr-consensus-segment-v16/route.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826095500_add_segment_level_ocr_consensus_v16.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const callStart = worker.indexOf('async function callSegmentVision');
const callEnd = worker.indexOf('function sanitizeSegment');
assert(callStart >= 0 && callEnd > callStart, 'callSegmentVision must exist.');
const callFn = worker.slice(callStart, callEnd);

assert(!/google_text/.test(callFn), 'Segment model call must never reference Google OCR text.');
assert(callFn.includes('exactly ONE segment image'), 'Prompt must explicitly bind the model to exactly one segment image.');
assert(callFn.includes('do not receive Google OCR, candidate text, the article overview, adjacent segments'), 'Prompt must prohibit candidate/overview/adjacent-segment context.');
assert(callFn.includes('emit 〓 rather than guessing'), 'Prompt must require 〓 for unreadable characters.');
assert(callFn.includes('Never summarize, paraphrase, normalize, rewrite, reorder, or silently repair'), 'Prompt must prohibit reconstruction and normalization.');
assert((callFn.match(/type: 'input_image'/g) || []).length === 1, 'Each model call must contain exactly one input image.');
assert(callFn.includes("name: 'mj_independent_ocr_segment_v16'") || worker.includes("name: 'mj_independent_ocr_segment_v16'"), 'Strict segment structured-output schema must be used.');

assert(worker.includes("receipts.map((row) => row.transcription).join('\\n')"), 'Article transcription must be mechanical sequence concatenation only.');
assert(worker.includes('const confidence = Math.min(...receipts.map((row) => row.confidence))'), 'Article confidence must conservatively use the minimum segment confidence.');
assert(worker.includes("supabaseAdmin.rpc('claim_ocr_consensus_canary_v16'"), 'Worker must use canary-only claim RPC.');
assert(worker.includes("supabaseAdmin.rpc('append_ocr_independent_pass_v11'"), 'Assembled article must flow through the unchanged v11 hard-gate evidence path.');
assert(worker.includes("supabaseAdmin.rpc('decide_ocr_consensus_article_v11'"), 'Decision must remain the existing v11 hard gate.');

assert(migration.includes("j.status='queued' and j.is_canary is true"), 'DB claim must be canary-only.');
assert(migration.includes('ocr_independent_segment_receipts_v16'), 'Segment evidence receipts table must exist.');
assert(migration.includes("'segment_receipts'"), 'Canary requeue archive must include segment receipts.');
assert(migration.includes('delete from public.ocr_independent_segment_receipts_v16'), 'Canary requeue must clear current segment receipts after archival.');
assert(!migration.includes('decide_ocr_consensus_article_v11'), 'v16 migration must not replace or weaken the v11 decision function.');
assert(route.includes('requireAppPassword(req)'), 'Segment worker route must remain authenticated.');

console.log('verify-ocr-segment-v16: ok');
