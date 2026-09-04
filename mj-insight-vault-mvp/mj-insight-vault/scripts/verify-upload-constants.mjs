import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const stable = read('components/UploadFormStable.tsx');
const draftStore = read('lib/uploadDraftStore.ts');
const articlesApi = read('app/api/cloud-stock/articles/route.ts');
const retiredArticlesApi = read('app/api/articles/route.ts');
const chatNo160 = read('lib/chatRouteNo160.ts');
const chatCore = read('lib/chatRouteCore.ts');
const wide = read('lib/wideArticleRetrieval.ts');
const batchesApi = read('app/api/batches/route.ts');
const processRoute = read('app/api/source-images/[id]/process/route.ts');
const reprocessRoute = read('app/api/source-images/[id]/reprocess/route.ts');
const commitHelper = read('lib/sourceImageArticleCommit.ts');
const atomicMigration = read('supabase/migrations/20260806162000_atomic_source_image_article_commit.sql');
const provenanceMigration = read('supabase/migrations/20260806170000_add_article_text_provenance.sql');

assert(/const MAX_ATTEMPTS = 3;/.test(stable), 'Upload retry count must remain MAX_ATTEMPTS = 3.');
assert(/const OCR_MAX_IMAGE_SIDE = 4200;/.test(stable), 'OCR max image side must remain 4200.');
assert(/const OCR_JPEG_QUALITY = 0\.95;/.test(stable), 'OCR JPEG quality must remain 0.95.');
assert(/async function withRetry/.test(stable), 'Upload retry helper withRetry() is missing.');
assert(/failedFiles/.test(stable), 'Upload failure tracking failedFiles is missing.');
assert(/失敗分だけ/.test(stable), 'Failed-only recovery UI text is missing.');
assert(/readUploadDraft/.test(stable) && /writeUploadDraft/.test(stable), 'Upload form must use IndexedDB draft recovery helpers.');
assert(/mj-upload-draft-v1/.test(draftStore), 'Upload draft DB key changed unexpectedly.');

// Canonical article pagination now lives in the Neon cloud-stock API. Do not reintroduce
// the old Supabase /api/articles path merely to preserve this historical guard.
assert(!/limit=300|\.limit\(300\)/.test(articlesApi), 'Canonical Neon article API must not use a fixed 300 row limit.');
assert(/const pageSize = 500/.test(articlesApi) && /offset=\$\{offset\}/.test(articlesApi), 'Canonical Neon article API must page through articles.');
assert(/for \(let offset = 0; offset < 5000; offset \+= pageSize\)/.test(articlesApi), 'Canonical Neon article API must iterate paged results.');
assert(/status:\s*410/.test(retiredArticlesApi), 'Legacy Supabase /api/articles must stay retired.');

for (const [file, source] of [['lib/chatRouteNo160.ts', chatNo160], ['lib/chatRouteCore.ts', chatCore], ['lib/wideArticleRetrieval.ts', wide]]) {
  assert(!/\.limit\(160\)/.test(source), `${file} must not use .limit(160).`);
}
assert(/fetchAllWideArticles/.test(chatNo160), 'No-160 chat route must use wide article retrieval.');
assert(/PAGE_SIZE = 1000/.test(wide) && /\.range\(from, from \+ PAGE_SIZE - 1\)/.test(wide), 'Wide article retrieval must page through all articles.');
assert(/\.from\('upload_batches'\)[\s\S]*?\.select\('\*'\)/.test(batchesApi), '/api/batches must fetch the batch list without unused embedded relation counts.');
assert(!/source_images\(count\)|articles\(count\)/.test(batchesApi), '/api/batches must not depend on embedded relation count resolution.');

assert(/commit_source_image_articles_v1/.test(atomicMigration), 'Article candidates must be committed by one database transaction.');
assert(/for update/.test(atomicMigration), 'Source image commit must serialize concurrent processing.');
assert(/source_image_already_has_active_articles/.test(atomicMigration), 'Normal processing must not append to an already committed image.');
assert(/p_replace_existing/.test(atomicMigration) && /source_image_reprocessed/.test(atomicMigration), 'Reprocessing must replace old articles inside the same transaction.');
assert(/exception when unique_violation/.test(atomicMigration), 'Concurrent duplicate insertion must be converted into an auditable duplicate result.');
assert(/enrichment_status/.test(atomicMigration) && /embedding_failed/.test(atomicMigration), 'Embedding state must be separate from article commit state.');

for (const [name, source] of [['process', processRoute], ['reprocess', reprocessRoute]]) {
  assert(/handleOcrOnly/.test(source), `${name} must delegate to the gated OCR-only path while OCR Verification is not authoritative.`);
  assert(!/commitSourceImageArticles/.test(source), `${name} must not commit articles before the OCR gate passes.`);
  assert(!/enrichCommittedArticles/.test(source), `${name} must not enrich articles before the OCR gate passes.`);
  assert(!/persistCommittedArticleProvenance/.test(source), `${name} must not persist formal article provenance before the OCR gate passes.`);
  assert(!/\.from\('articles'\)[\s\S]*?\.insert/.test(source), `${name} must not insert articles directly.`);
}

assert(/upsert\(/.test(commitHelper) && /onConflict: 'article_id'/.test(commitHelper), 'Embedding writes must be idempotent.');
assert(/recordEnrichmentFailure/.test(commitHelper), 'Embedding failures must be persisted without rolling back articles.');

assert(/source_ocr_sha256/.test(provenanceMigration) && /analysis_text_sha256/.test(provenanceMigration), 'Formal articles must persist source and analysis text fingerprints.');
assert(/legacy_vision_llm_reconstruction/.test(provenanceMigration), 'Existing reconstructed articles must be explicitly classified as legacy reconstruction.');
assert(/provenance_status in \('traceable', 'legacy_traceable'\)/.test(provenanceMigration), 'Formal corpus view must exclude untraceable articles.');
assert(/article_provenance_audit_v1/.test(provenanceMigration), 'Article provenance hashes must be auditable against current stored text.');
assert(/createHash\('sha256'\)/.test(commitHelper), 'Runtime provenance must use SHA-256.');
assert(/vision_llm_reconstruction/.test(commitHelper) && /text_llm_segmentation/.test(commitHelper) && /raw_ocr_fallback/.test(commitHelper), 'Runtime provenance must distinguish all article text paths.');
assert(/provenance_status: 'traceable'/.test(commitHelper), 'New articles must be explicitly marked traceable after provenance persistence.');
assert(/recordProvenanceFailure/.test(commitHelper), 'Failed provenance writes must fail closed and exclude the article from formal analysis.');

console.log('verify-upload-constants: ok');
