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
const articlesApi = read('app/api/articles/route.ts');
const chatNo160 = read('lib/chatRouteNo160.ts');
const chatCore = read('lib/chatRouteCore.ts');
const wide = read('lib/wideArticleRetrieval.ts');
const batchesApi = read('app/api/batches/route.ts');

assert(/const MAX_ATTEMPTS = 3;/.test(stable), 'Upload retry count must remain MAX_ATTEMPTS = 3.');
assert(/const OCR_MAX_IMAGE_SIDE = 4200;/.test(stable), 'OCR max image side must remain 4200.');
assert(/const OCR_JPEG_QUALITY = 0\.95;/.test(stable), 'OCR JPEG quality must remain 0.95.');
assert(/async function withRetry/.test(stable), 'Upload retry helper withRetry() is missing.');
assert(/failedFiles/.test(stable), 'Upload failure tracking failedFiles is missing.');
assert(/失敗分だけ/.test(stable), 'Failed-only recovery UI text is missing.');
assert(/readUploadDraft/.test(stable) && /writeUploadDraft/.test(stable), 'Upload form must use IndexedDB draft recovery helpers.');
assert(/mj-upload-draft-v1/.test(draftStore), 'Upload draft DB key changed unexpectedly.');

assert(!/\.limit\(300\)/.test(articlesApi), '/api/articles must not use a fixed 300 row limit.');
assert(/PAGE_SIZE = 1000/.test(articlesApi) && /\.range\(from, from \+ PAGE_SIZE - 1\)/.test(articlesApi), '/api/articles must page through articles.');
assert(/limit_removed:\s*true/.test(articlesApi), '/api/articles should expose that fixed limits were removed.');

for (const [file, source] of [['lib/chatRouteNo160.ts', chatNo160], ['lib/chatRouteCore.ts', chatCore], ['lib/wideArticleRetrieval.ts', wide]]) {
  assert(!/\.limit\(160\)/.test(source), `${file} must not use .limit(160).`);
}
assert(/fetchAllWideArticles/.test(chatNo160), 'No-160 chat route must use wide article retrieval.');
assert(/PAGE_SIZE = 1000/.test(wide) && /\.range\(from, from \+ PAGE_SIZE - 1\)/.test(wide), 'Wide article retrieval must page through all articles.');
assert(/\.from\('upload_batches'\)[\s\S]*?\.select\('\*'\)/.test(batchesApi), '/api/batches must fetch the batch list without unused embedded relation counts.');
assert(!/source_images\(count\)|articles\(count\)/.test(batchesApi), '/api/batches must not depend on embedded relation count resolution.');

console.log('verify-upload-constants: ok');
