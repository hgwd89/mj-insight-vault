import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workerPath = path.join(root, 'lib', 'articleInventoryWorker.ts');
const routePath = path.join(root, 'app', 'api', 'article-inventory', 'worker', 'route.ts');
const worker = fs.readFileSync(workerPath, 'utf8');
const route = fs.readFileSync(routePath, 'utf8');

const checks = [
  ['claims strict inventory jobs', worker.includes("claim_source_page_article_inventory_job_v1")],
  ['blind inventory pass is persisted', worker.includes("replace_source_page_article_inventory_pass_v1")],
  ['blind prompt states existing registry is absent', worker.includes('You are NOT given the existing article registry')],
  ['blind output has no mapped_article_id field', !worker.match(/mapped_article_id\s*:/)],
  ['all OCR blocks are sent without text slicing', !worker.includes('block_text).slice(') && !worker.includes('blocksForPrompt(blocks).slice(')],
  ['low confidence stops for review', worker.includes('ReviewRequiredError') && worker.includes('review_source_page_article_inventory_job_v1')],
  ['independent third pass is explicit', worker.includes('OPENAI_INVENTORY_ADJUDICATOR_MODEL') && worker.includes("['adjudicator', models.adjudicator]")],
  ['blind discovery and stored-article mapping are separate stages', worker.includes('loadMappingInput') && worker.includes('one_to_one_article_identity_mapping')],
  ['mapping requires dual passes', worker.includes("if (!existing.has('mapper'))") && worker.includes("if (!existing.has('critic'))")],
  ['final DB gate is used', worker.includes('finalize_source_page_article_inventory_job_v1')],
  ['worker is manually authenticated', route.includes('requireAppPassword(req)')],
  ['no cron or automatic loop in route', !route.includes('setInterval') && !route.includes('while ('))
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
  console.error(`Article inventory worker verification failed: ${failed.map(([name]) => name).join(', ')}`);
  process.exit(1);
}
console.log('Article inventory worker verification passed.');
