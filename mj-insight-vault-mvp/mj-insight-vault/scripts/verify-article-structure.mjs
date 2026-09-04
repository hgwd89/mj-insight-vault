import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const segmentation = read('lib/articleSegmentation.ts');
const text = read('lib/text.ts');
const processRoute = read('app/api/source-images/[id]/process/route.ts');
const reprocessRoute = read('app/api/source-images/[id]/reprocess/route.ts');
const ocrOnlyRoute = read('app/api/source-images/[id]/ocr-only/route.ts');
const articlesApi = read('app/api/cloud-stock/articles/route.ts');
const articleDetailApi = read('app/api/cloud-stock/articles/[id]/route.ts');
const originalContentApi = read('app/api/cloud-stock/files/[id]/content/route.ts');
const retiredArticlesApi = read('app/api/articles/route.ts');
const fixtures = JSON.parse(read('scripts/fixtures/article-structure-cases.json'));

const allowedTypes = new Set(['article', 'table', 'chart', 'caption', 'unknown']);

function isValidDate(value) {
  return value === null || value === undefined || value === '' || /^\d{4}-\d{1,2}(-\d{1,2})?$/.test(value) || /^\d{4}年\s*\d{1,2}月/.test(value);
}

function validateCandidate(candidate) {
  return Boolean(
    candidate
    && typeof candidate.headline === 'string'
    && candidate.headline.trim()
    && typeof candidate.ocr_text === 'string'
    && candidate.ocr_text.trim()
    && isValidDate(candidate.article_date)
    && allowedTypes.has(candidate.article_type)
    && typeof candidate.has_table === 'boolean'
    && typeof candidate.has_chart === 'boolean'
    && typeof candidate.has_image === 'boolean'
  );
}

for (const field of ['headline', 'article_date', 'ocr_text', 'article_type', 'has_table', 'has_chart', 'has_image']) {
  assert(segmentation.includes(field), `Article structuring must keep ${field}.`);
}

assert(/body_reconstructed/.test(segmentation), 'OpenAI article structuring must keep reconstructed body text.');
assert(/facts/.test(segmentation) && /numbers/.test(segmentation) && /figures/.test(segmentation), 'Article structuring must preserve facts, numbers, and figures.');
assert(/noise/.test(segmentation), 'Article structuring must separate noise.');
assert(/推測で数字を作らない/.test(segmentation), 'Article structuring prompt must forbid fabricated numbers.');
assert(/画像上で読めないものは空文字またはlow confidence/.test(segmentation), 'Article structuring prompt must handle unreadable image text explicitly.');
assert(/isOpenAIQuotaError/.test(segmentation), 'OpenAI quota errors must not be hidden as article text.');
assert(!/【GPT画像構造化失敗】/.test(segmentation), 'GPT structuring failures must not be saved as article body text.');
assert(/fallbackArticle\(normalizedOcr\)/.test(segmentation), 'Fallback article must use clean OCR text.');

assert(/normalizeOcrText/.test(text), 'OCR text normalization helper is missing.');

// Nano-safe mode must fail closed: the public process/reprocess endpoints may OCR source
// images but must not segment, commit, enrich, classify, or report until the authoritative
// OCR rollout gate has passed and the gated downstream pipeline takes over.
for (const [name, route] of [['process', processRoute], ['reprocess', reprocessRoute]]) {
  assert(/handleOcrOnly/.test(route) && /POST\s*=\s*handleOcrOnly/.test(route), `${name} must delegate to the OCR-only route.`);
  assert(!/segmentArticlesFromImage|commitSourceImageArticles|enrichCommittedArticles/.test(route), `${name} must not bypass the OCR verification gate.`);
}

assert(/ocr_text_raw/.test(ocrOnlyRoute), 'OCR-only processing must store normalized OCR text.');
assert(!/ocr_json\s*:/.test(ocrOnlyRoute), 'Nano OCR-only processing must not persist raw provider JSON.');
assert(/raw_provider_json_written:\s*false/.test(ocrOnlyRoute), 'OCR-only response must state that raw provider JSON was not written.');
assert(/articles_created:\s*0/.test(ocrOnlyRoute), 'OCR-only processing must not create articles.');
assert(!/segmentArticlesFromImage|commitSourceImageArticles|enrichCommittedArticles/.test(ocrOnlyRoute), 'OCR-only route must not start formal downstream work.');

// Canonical browsing is Google Drive + Neon. The list must resolve source metadata, the
// detail must expose the linked Drive original, and original bytes must come from Drive.
assert(/vault_articles/.test(articlesApi) && /vault_source_files/.test(articlesApi), 'Canonical Articles API must join Neon article/source metadata.');
assert(/source_file_name/.test(articlesApi), 'Canonical Articles API must expose source filename metadata.');
assert(/drive_file_id/.test(articleDetailApi) && /original_available/.test(articleDetailApi), 'Article detail API must expose linked Google Drive original metadata.');
assert(/downloadGoogleDriveFile/.test(originalContentApi) && /requireNeonJwt/.test(originalContentApi), 'Original content API must resolve Neon metadata and read Google Drive bytes.');
assert(!/supabaseAdmin|@supabase\//.test(articlesApi + articleDetailApi + originalContentApi), 'Canonical article/original APIs must not depend on Supabase.');
assert(/status:\s*410/.test(retiredArticlesApi) && !/supabaseAdmin/.test(retiredArticlesApi), 'Legacy Supabase article API must stay retired.');

for (const candidate of fixtures.valid || []) {
  assert(validateCandidate(candidate), `Expected valid article fixture to pass: ${JSON.stringify(candidate)}`);
}

for (const candidate of fixtures.invalid || []) {
  assert(!validateCandidate(candidate), `Expected invalid article fixture to fail: ${JSON.stringify(candidate)}`);
}

console.log('verify-article-structure: ok');
