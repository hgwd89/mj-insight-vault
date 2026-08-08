import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib', 'articleInventoryWorker.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app', 'api', 'article-inventory', 'worker', 'route.ts'), 'utf8');
const lifecycle = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260808030131_make_inventory_worker_stepwise_v2.sql'), 'utf8');

const checks = [
  ['claims v2 stepwise inventory jobs', worker.includes('claim_source_page_article_inventory_job_v2')],
  ['completed pass yields instead of chaining calls', worker.includes('yield_source_page_article_inventory_job_v2')],
  ['v2 failure accounting is used', worker.includes('fail_source_page_article_inventory_job_v2')],
  ['blind prompt hides existing article registry', worker.includes('You are NOT given the existing article registry')],
  ['blind partition has no max article count', worker.includes('There is no maximum article count')],
  ['blind output has no mapped_article_id field', !worker.match(/mapped_article_id\s*:/)],
  ['all OCR blocks are sent without slicing', !worker.includes('block_text).slice(') && !worker.includes('blocksForPrompt(blocks).slice(')],
  ['low confidence fails closed for review', worker.includes('ReviewRequiredError') && worker.includes('review_source_page_article_inventory_job_v1')],
  ['third pass has an explicit independent default', worker.includes("|| 'gpt-4o-mini'") && worker.includes("blindPasses.has('adjudicator')")],
  ['stored-article mapping is a separate post-discovery stage', worker.includes('loadMappingInput') && worker.includes('one_to_one_article_identity_mapping')],
  ['mapping is dual pass', worker.includes("mappingPasses.has('mapper')") && worker.includes("mappingPasses.has('critic')")],
  ['one call timeout fits route budget', /const CALL_TIMEOUT_MS = 150_000;/.test(worker) && /maxDuration = 240/.test(route)],
  ['old multi-pass orchestration is absent', !worker.includes('runRequiredBlindPasses') && !worker.includes('ensureMappingProof')],
  ['route executes worker exactly once', (route.match(/runArticleInventoryWorkerStep\(\)/g) || []).length === 1],
  ['route has no automatic loop', !route.includes('setInterval') && !route.includes('while (')],
  ['route is manually authenticated', route.includes('requireAppPassword(req)')],
  ['DB lifecycle includes explicit yield', lifecycle.includes('yield_source_page_article_inventory_job_v2')],
  ['DB normal yield does not increment failures', lifecycle.includes("set status='queued',lease_token=null,lease_expires_at=null")],
  ['DB structural failures stop for review', lifecycle.includes("when v_structural then 'needs_review'")],
  ['old v1 claim is revoked from service role', lifecycle.includes('revoke execute on function public.claim_source_page_article_inventory_job_v1(integer) from service_role')]
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
  console.error(`Article inventory worker verification failed: ${failed.map(([name]) => name).join(', ')}`);
  process.exit(1);
}
console.log('Article inventory worker verification passed.');
