import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/articleInventoryWorkerV6Grounded.ts'), 'utf8');
const consensus = fs.readFileSync(path.join(root, 'lib/articleInventoryWorkerV5Consensus.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/buildcheck/inventory-v3/route.ts'), 'utf8');

const checks = [
  ['route uses grounded v6 worker', route.includes('runArticleInventoryWorkerV6GroundedStep')],
  ['v6 never delegates raw passes to v4', !worker.includes('runArticleInventoryWorkerV4VisionStep')],
  ['raw visual region evidence is persisted', worker.includes('source_page_inventory_visual_region_evidence_v6') && worker.includes('persistRegionEvidence')],
  ['zero-block visual regions are retained as evidence', worker.includes('dropped_from_partition') && worker.includes('grounded_block_count')],
  ['two independent zero-block detections fail closed', worker.includes('checkSupportedUngroundedRegions') && worker.includes('Two independent visual passes support an article region with zero fresh OCR blocks')],
  ['ambiguous blocks are recorded rather than rejected in raw pass', worker.includes('ambiguousByArticle') && !worker.includes('overlap ambiguously for')],
  ['raw pass confidence floor is 0.60', worker.includes('RAW_MIN_CONFIDENCE = 0.60')],
  ['mapper critic adjudicator defaults are independent', worker.includes("'gpt-4o'") && worker.includes("'gpt-4o-mini'") && worker.includes('requireDistinctModels')],
  ['fresh OCR provenance is checked', worker.includes('source_page_article_inventory_blocks_v1') && worker.includes('Fresh OCR block provenance drift')],
  ['raw prompt is blind to database article registry', !worker.includes('existing_article_count') && worker.includes('Do not use database article counts')],
  ['v6 delegates final consensus to v5', worker.includes('runArticleInventoryWorkerV5ConsensusStep')],
  ['v5 final visual confidence remains 0.80', consensus.includes('confidence < 0.80')],
  ['v5 requires independent support', consensus.includes('One-model-only visual article has no independent support')],
  ['route budget remains 300 seconds', route.includes('export const maxDuration = 300')],
  ['single OpenAI call timeout stays below route budget', worker.includes('AbortSignal.timeout(180000)')]
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error('Grounded article inventory v6 contract verification failed.');
  process.exit(1);
}
console.log('Grounded article inventory v6 contract verification passed.');
