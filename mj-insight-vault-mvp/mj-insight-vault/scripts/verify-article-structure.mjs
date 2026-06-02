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
const articlesApi = read('app/api/articles/route.ts');
const articleDetailApi = read('app/api/articles/[id]/route.ts');

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
assert(/ocr_text_raw/.test(processRoute) && /ocr_json/.test(processRoute), 'OCR raw text and OCR JSON must be stored on process.');
assert(/ocr_text_raw/.test(reprocessRoute) && /ocr_json/.test(reprocessRoute), 'OCR raw text and OCR JSON must be stored on reprocess.');
assert(/source_image_id/.test(processRoute) && /batch_id/.test(processRoute), 'Created articles must retain source image and batch linkage.');
assert(/source_images\(id, file_name, storage_path, mime_type\)/.test(articlesApi), 'Articles API should expose source image metadata.');
assert(/article_tags/.test(articleDetailApi), 'Article detail API should preserve article tags.');

console.log('verify-article-structure: ok');
