import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function assertIncludes(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
}

function assertExcludes(source, forbidden, label) {
  if (source.includes(forbidden)) throw new Error(`${label}: forbidden ${JSON.stringify(forbidden)}`);
}

function assertOrdered(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    if (next < 0) throw new Error(`${label}: missing ${JSON.stringify(token)}`);
    if (next <= cursor) throw new Error(`${label}: out of order at ${JSON.stringify(token)}`);
    cursor = next;
  }
}

const scheduler = read('app/api/internal/verified-pipeline-scheduler/route.ts');
assertOrdered(scheduler, [
  "runWorkerBatch('ocr_verification'",
  'ensureVerifiedOcrCorpusReceipt()',
  "runWorkerBatch('embedding'",
  "runWorkerBatch('duplicate_audit'",
  "runWorkerBatch('classification'",
  "runWorkerBatch('article_review'",
  "runWorkerBatch('theme_candidates'",
  "runWorkerBatch('theme_census'",
  'ensureVerifiedThemeAnalysisProof()',
  'runVerifiedThemeReportWorkerV15Step'
], 'verified pipeline dependency order must remain strict');
assertIncludes(scheduler, "gate?.ocr_verification_gate !== 'passed'", 'verified OCR corpus receipt must require the OCR gate');
assertIncludes(scheduler, "census?.census_gate !== 'passed'", 'theme analysis proof must require the census gate');
assertIncludes(scheduler, 'requireAppPassword(req)', 'verified pipeline scheduler must remain authenticated');
assertIncludes(scheduler, 'const failures = settled.flatMap', 'verified pipeline scheduler must collect rejected worker lanes');
assertIncludes(scheduler, 'if (failures.length > 0)', 'verified pipeline scheduler must fail closed on rejected worker lanes');
assertIncludes(scheduler, 'worker lane failure', 'verified pipeline scheduler must surface rejected worker lanes');

const verifiedEntrypoints = [
  {
    path: 'app/api/classification/worker/route.ts',
    requiredImport: "@/lib/verifiedArticleClassificationWorker",
    requiredCall: 'runVerifiedArticleClassificationWorkerStep',
    forbiddenImports: ['@/lib/articleClassificationWorker', '@/lib/articleClassificationWorkerSafe']
  },
  {
    path: 'app/api/article-review/worker/route.ts',
    requiredImport: "@/lib/verifiedArticleReviewWorker",
    requiredCall: 'runVerifiedArticleReviewWorkerStep',
    forbiddenImports: []
  },
  {
    path: 'app/api/theme-candidates/worker/route.ts',
    requiredImport: "@/lib/verifiedThemeCandidateWorker",
    requiredCall: 'runVerifiedThemeCandidateWorkerStep',
    forbiddenImports: []
  },
  {
    path: 'app/api/theme-census/worker/route.ts',
    requiredImport: "@/lib/verifiedThemeCensusWorker",
    requiredCall: 'runVerifiedThemeCensusWorkerStep',
    forbiddenImports: []
  }
];

for (const entrypoint of verifiedEntrypoints) {
  const source = read(entrypoint.path);
  assertIncludes(source, entrypoint.requiredImport, `${entrypoint.path} must use the verified worker`);
  assertIncludes(source, entrypoint.requiredCall, `${entrypoint.path} must call the verified worker`);
  assertIncludes(source, 'requireAppPassword(req)', `${entrypoint.path} must remain authenticated`);
  for (const forbidden of entrypoint.forbiddenImports) {
    assertExcludes(source, forbidden, `${entrypoint.path} must not fall back to legacy classification`);
  }
}

const comparison = read('supabase/migrations/20260826135000_add_ocr_canary_method_comparison_v19.sql');
assertIncludes(comparison, 'with (security_invoker = true)', 'OCR canary comparison view must be security invoker');
assertIncludes(comparison, 'v16_google_sol_similarity', 'OCR canary comparison must retain v16 metrics');
assertIncludes(comparison, 'legacy_google_sol_similarity', 'OCR canary comparison must retain legacy metrics');
assertIncludes(comparison, 'current_sol_piece_receipts', 'OCR canary comparison must expose v18 progress');
assertIncludes(comparison, 'revoke all on public.ocr_canary_method_comparison_v19 from public, anon, authenticated', 'OCR canary comparison must stay internal');

const resume = read('supabase/migrations/20260826135500_add_preserving_v18_canary_resume_v19.sql');
assertIncludes(resume, 'security invoker', 'canary resume must not add a SECURITY DEFINER surface');
assertIncludes(resume, "j.is_canary is distinct from true", 'canary resume must remain canary-only');
assertIncludes(resume, "j.status = 'running'", 'canary resume must reject active leases');
assertIncludes(resume, "article_block_local_vertical_segments_v1", 'canary resume must bind preserved pieces to v18 segmentation');
if (resume.includes('delete from public.ocr_independent_segment_receipts_v16')) {
  throw new Error('canary resume must preserve partial v18 piece receipts');
}

const postOcr = read('supabase/migrations/20260826140000_add_post_ocr_verified_pipeline_drain_v2.sql');
assertIncludes(postOcr, "v_ocr_gate is distinct from 'passed'", 'post-OCR drain must not start downstream work before OCR passes');
assertIncludes(postOcr, 'strict_system_safety_audit_v24', 'post-OCR drain must require system safety');
assertIncludes(postOcr, 'request_verified_pipeline_scheduler_tick_v1()', 'post-OCR drain must use the canonical verified scheduler');
assertIncludes(postOcr, "'* * * * *'", 'post-OCR drain must remove manual handoff delay');

console.log('verified pipeline dependency-order and entrypoint regression checks passed');
