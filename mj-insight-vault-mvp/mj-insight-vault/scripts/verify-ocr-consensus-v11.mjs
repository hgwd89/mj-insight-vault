import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/ocrConsensusWorkerV11.ts'), 'utf8');
const crop = fs.readFileSync(path.join(root, 'lib/articleCrop.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/ocr-consensus-v11/route.ts'), 'utf8');
const migrationDir = path.join(root, 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationDir).filter((name) => name.endsWith('_add_ocr_consensus_v11_schema.sql'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(migrationNames.length === 1, `Exactly one OCR consensus v11 schema migration is required; found ${migrationNames.length}.`);
const sql = fs.readFileSync(path.join(migrationDir, migrationNames[0]), 'utf8');

const decideFn = sql.slice(sql.indexOf('function public.decide_ocr_consensus_article_v11'));

// A. review/low region + perfect Sol confidence/similarity/numeric must never single-pass; Terra is still required.
assert(
  /if v_region_quality = 'strong'[\s\S]*?elsif e\.terra_text is null then\s*\n\s*return jsonb_build_object\('status', 'terra_required'/.test(decideFn),
  'A review/low region must fall through the strong-only single-pass branch straight into the terra_required branch, never passed_single.'
);

// B. strong region with the exact hardened thresholds must single-pass.
for (const clause of [
  "v_region_quality = 'strong'",
  'e.sol_confidence >= 0.95',
  "e.sol_output_contract_status = 'passed'",
  "e.sol_proper_noun_status <> 'failed'",
  'coalesce(e.google_sol_similarity, 0) >= 0.97',
  'e.google_sol_numeric_equal is true'
]) {
  assert(decideFn.includes(clause), `Single-pass gate must keep required clause: ${clause}`);
}
assert(/v_status := 'passed_single'/.test(decideFn), 'Single-pass branch must set passed_single.');

// C. two-model consensus thresholds must remain exactly this strict.
for (const clause of [
  'e.sol_confidence >= 0.88',
  'e.terra_confidence >= 0.88',
  "e.sol_output_contract_status = 'passed'",
  "e.terra_output_contract_status = 'passed'",
  "e.sol_proper_noun_status <> 'failed'",
  "e.terra_proper_noun_status <> 'failed'",
  'coalesce(e.sol_terra_similarity, 0) >= 0.96',
  'e.sol_terra_numeric_equal is true',
  'e.sol_terra_proper_noun_agreement is true'
]) {
  assert(decideFn.includes(clause), `Two-model gate must keep required clause: ${clause}`);
}
assert(/v_status := 'passed_two_model'/.test(decideFn), 'Two-model branch must set passed_two_model.');

// D. everything else (Sol/Terra disagreement) must fall through to needs_review.
assert(/else\s*\n\s*v_status := 'needs_review'/.test(decideFn), 'The final else branch must remain needs_review.');
assert(
  !/lower(?:ed)?|threshold\s*=\s*0\.[0-7]/i.test(decideFn),
  'Decision function must not contain a weakened/lowered threshold marker.'
);

// E. needs_review must never write a canonical receipt row.
const canonicalInsertGuard = decideFn.slice(decideFn.indexOf("if v_status like 'passed_%' then"));
assert(canonicalInsertGuard.startsWith("if v_status like 'passed_%' then"), 'The article_ocr_verifications_v11 insert must be gated strictly on passed_% status.');
assert(canonicalInsertGuard.indexOf('insert into public.article_ocr_verifications_v11') < canonicalInsertGuard.indexOf('end if;'), 'The canonical insert must live inside the passed_% guard, not after it.');
const decisionsTable = sql.slice(sql.indexOf('create table if not exists public.ocr_consensus_decisions_v11'), sql.indexOf('create table if not exists public.article_ocr_verifications_v11'));
assert(
  decisionsTable.includes("decision_status = 'needs_review' and selected_source is null and canonical_text is null and canonical_text_sha256 is null"),
  'The decisions table must keep the DB-level check that needs_review rows carry no canonical text.'
);

// F. Sol/Terra must never receive Google OCR text as prompt input.
const callFn = worker.slice(worker.indexOf('async function callIndependentVision'), worker.indexOf('function inputBinding'));
assert(!/google_text/.test(callFn), 'callIndependentVision must never reference google_text in the request it sends to OpenAI.');
assert(callFn.includes('You are NOT given any candidate OCR'), 'The vision instructions must explicitly tell the model it receives no candidate OCR.');
assert(callFn.includes('crop.buffer.toString'), 'callIndependentVision must retain a full geometry-preserving overview image.');
assert(callFn.includes('segment.buffer.toString'), 'callIndependentVision must send enlarged reading-segment images as primary OCR evidence.');

// G. article ID bijection: unknown/duplicate/missing rows must be rejected.
const sanitizeFn = worker.slice(worker.indexOf('function sanitizeRows'), worker.indexOf('async function runPassChunk'));
assert(/!expected\.has\(articleId\) \|\| seen\.has\(articleId\)/.test(sanitizeFn), 'sanitizeRows must reject unknown or duplicate article ids.');
assert(worker.includes('if (rows.length !== crops.length) throw new ProviderError'), 'A short/incomplete row set must be rejected.');
assert(sql.includes("raise exception 'ocr_consensus_v11_unknown_article'"), 'DB append must independently reject unknown article ids.');
assert(sql.includes("raise exception 'ocr_consensus_v11_duplicate_article'"), 'DB append must independently reject duplicate article ids.');
assert(sql.includes("raise exception 'ocr_consensus_v11_article_already_transcribed'"), 'DB append must reject re-transcribing an article already stored for that pass.');

// H. crop fingerprint mismatch must be rejected before any model call.
assert(
  worker.includes("composite.cropSpecSha256 !== article.crop_spec_sha256 || composite.cropImageSha256 !== article.crop_image_sha256") &&
  worker.includes('OCR consensus v11 crop fingerprint changed'),
  'buildComposites must reject a recomputed crop that does not match the stored crop fingerprint.'
);
assert(sql.includes('v_binding is distinct from p_input_binding_sha256'), 'DB append must independently re-verify the crop/input binding fingerprint server-side.');

// I. source image SHA mismatch must be rejected.
assert(
  worker.includes('article.source_image_sha256 !== sourceImageSha256') && worker.includes('OCR consensus v11 source image binding changed'),
  'loadInput must reject when the downloaded source image no longer matches the bound source image SHA-256.'
);

// J. Sol and Terra must never resolve to the same model.
assert(
  /if \(!sol \|\| !terra \|\| sol === terra\) throw new StructuralOutputError/.test(worker),
  'configuredModels must reject identical Sol/Terra models at the application layer.'
);
assert(sql.includes("raise exception 'ocr_consensus_v11_independent_model_required'"), 'DB append must independently reject a pass whose model matches the other pass for the same job.');

// K. Vertical newspaper OCR must use deterministic segmentation rather than whole-article-only OCR.
assert(worker.includes('const VISION_CHUNK = 1;'), 'Segmented OCR canary must process one article per provider call to bound image count and isolate failures.');
assert(worker.includes('buildArticleReadingSegments'), 'The OCR worker must derive reading segments after validating the stored v3 crop fingerprint.');
assert(callFn.includes('IMAGE=OVERVIEW'), 'Each article must include an overview image for layout context.');
assert(callFn.includes('READING_SEGMENT='), 'Each article must include explicitly sequenced reading-segment images.');
assert(callFn.includes('rightmost to leftmost'), 'The prompt must state the Japanese vertical right-to-left segment order.');
assert(callFn.includes('Do not duplicate text merely because it is also visible in the overview'), 'The prompt must prevent overview/segment duplicate transcription.');
assert(callFn.includes('Use the visible placeholder 〓'), 'The prompt must require an unreadable-character placeholder rather than invention.');

// L. Reading segmentation itself must be pixel-derived, deterministic, and have a no-gutter fallback.
for (const invariant of [
  "ARTICLE_READING_SEGMENT_VERSION = 'article_vertical_whitespace_segments_v1'",
  '.greyscale().raw().toBuffer({ resolveWithObject: true })',
  'function whitespaceBoundaries',
  'function fallbackBoundaries',
  "readingOrder: 'right_to_left_top_to_bottom'",
  'sort((a, b) => b.left - a.left)',
  'segmentationSpecSha256'
]) {
  assert(crop.includes(invariant), `Reading segmentation invariant missing: ${invariant}`);
}
assert(crop.includes('if (ranges.length === 1)'), 'A wide article without a clean whitespace gutter must fall back to low-ink target boundary splitting.');
assert(crop.includes('segment.imageSha256'), 'Every reading segment must be content-addressed for reproducibility.');

// Structural / safety invariants that must not regress.
assert(route.includes('requireAppPassword(req)'), 'The v11 canary route must remain authenticated.');
assert(worker.includes("|| 'gpt-5.6-sol'") && worker.includes("|| 'gpt-5.6-terra'"), 'Default Sol/Terra models must remain gpt-5.6-sol / gpt-5.6-terra unless overridden by env.');
assert(sql.includes("freeze_gate_v2='passed'") || sql.includes("freeze_gate_v2 = 'passed'"), 'Claim/input RPCs must require the current formal freeze to remain passed.');
for (const fn of ['claim_ocr_consensus_job_v11', 'get_ocr_consensus_page_input_v11', 'append_ocr_independent_pass_v11', 'decide_ocr_consensus_article_v11', 'yield_ocr_consensus_job_v11', 'finish_ocr_consensus_job_v11', 'fail_ocr_consensus_job_v11']) {
  assert(new RegExp(`revoke all on function public\\.${fn}\\(`).test(sql), `${fn} must be revoked from public/anon/authenticated.`);
  assert(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to postgres, service_role`).test(sql), `${fn} must be executable only by postgres/service_role.`);
}

console.log('verify-ocr-consensus-v11: ok');
