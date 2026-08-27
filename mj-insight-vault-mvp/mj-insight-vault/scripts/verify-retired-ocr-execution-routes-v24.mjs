import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const v11 = read('app/api/internal/ocr-consensus-v11/route.ts');
const v16 = read('app/api/internal/ocr-consensus-segment-v16/route.ts');
const independent = read('app/api/internal/ocr-independent-canary/route.ts');
const currentPiece = read('app/api/internal/ocr-consensus-piece-v18/route.ts');
const v16Kick = read('supabase/migrations/20260826100500_add_segment_canary_kick_v16.sql');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRetiredRoute(source, label, forbiddenRunner) {
  assert(source.includes('requireAppPassword(req)'), `${label} must remain authenticated.`);
  assert(source.includes("status: 'retired'"), `${label} POST must identify itself as retired.`);
  assert(source.includes('{ status: 410 }'), `${label} POST must fail closed with HTTP 410.`);
  assert(source.includes('/api/internal/ocr-consensus-piece-v18'), `${label} must point operators to the current piece route.`);
  assert(!source.includes(forbiddenRunner), `${label} must not retain an executable legacy runner import/call.`);
}

assertRetiredRoute(v11, 'v11 whole-article route', 'runOcrConsensusV11Step');
assertRetiredRoute(v16, 'v16 segment route', 'runOcrConsensusSegmentV16Step');
assertRetiredRoute(independent, 'obsolete independent canary probe', 'transcribeIndependent');

assert(!independent.includes('api.openai.com'), 'Retired independent canary route must not contain a direct OpenAI execution path.');
assert(!independent.includes('getOpenAIKey'), 'Retired independent canary route must not load an OpenAI key.');
assert(!independent.includes('google_candidate'), 'Retired independent canary route must not return Google candidate OCR.');

// The current piece route is intentionally the only executable OCR canary route.
// Its detailed V21 piece-binding and one-piece prompt invariants are locked by
// verify-ocr-piece-v18.mjs; this retirement guard only verifies that execution is
// scoped to the explicit v32 exact-two cohort and cannot fan out/full-rollout.
assert(currentPiece.includes('runOcrConsensusPieceV18Step()'), 'Current piece route must remain executable.');
assert(currentPiece.includes(".from('ocr_consensus_canary_runtime_v32')"), 'Current piece route must require explicit v32 runtime binding.');
assert(currentPiece.includes('if (allowed.size !== 2)'), 'Current piece route must require exactly two bound canary jobs.');
assert(currentPiece.includes('active canary job(s) outside the bound cohort'), 'Current piece route must fail closed on unscoped runnable canaries.');
assert(currentPiece.includes('full_rollout_execution: false'), 'Current piece route must keep full rollout disabled.');
assert((currentPiece.match(/runOcrConsensusPieceV18Step\(\)/g) || []).length === 1, 'Current piece route must execute exactly one worker step per request.');
assert(!currentPiece.includes('Promise.all(['), 'Current piece route must not fan out multiple workers inside one request.');

// Production still contains historical DB kick DDL for v16. Until authoritative DB
// connectivity returns and that function can be retired safely in production, its target
// must resolve to a route that now fails closed instead of executing the obsolete worker.
assert(v16Kick.includes('/api/internal/ocr-consensus-segment-v16'), 'Historical v16 kick target must be visible to this guard.');
assert(v16.includes('{ status: 410 }'), 'Historical v16 DB kick must terminate at an HTTP-410 route.');

console.log('verify-retired-ocr-execution-routes-v24: ok (legacy OCR POST execution fail-closed; current piece route exact-two scoped and single-step)');
