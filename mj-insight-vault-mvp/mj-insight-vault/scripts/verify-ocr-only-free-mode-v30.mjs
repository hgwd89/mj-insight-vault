import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}
function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`${label}: missing ${text}`);
}
function forbidText(source, text, label) {
  if (source.includes(text)) throw new Error(`${label}: forbidden ${text}`);
}

const mode = read('lib/pipelineMode.ts');
const proxy = read('proxy.ts');
const ocrRoute = read('app/api/source-images/[id]/ocr-only/route.ts');
const processRoute = read('app/api/source-images/[id]/process/route.ts');
const uploadPage = read('app/upload/page.tsx');
const uploadForm = read('components/UploadFormOcrOnly.tsx');
const stockApi = read('app/api/ocr-stock/batches/[id]/route.ts');
const stockList = read('app/ocr-stock/page.tsx');
const stockDetail = read('app/ocr-stock/[id]/page.tsx');
const migration = read('supabase/migrations/20260827050000_harden_nano_ocr_only_mode_v30.sql');

requireText(mode, "process.env.MJ_PIPELINE_MODE || 'ocr_only'", 'mode defaults to OCR-only');
requireText(mode, "value === 'full' ? 'full' : 'ocr_only'", 'full mode must be explicit');

for (const text of [
  "path === '/api/batches'",
  '/api\\/ocr-stock\\/batches',
  "path === '/api/upload/start'",
  "path === '/api/upload/image'",
  '/source-images\\/[^/]+\\/ocr-only',
  'status: 423',
  'full_pipeline_locked: true'
]) requireText(proxy, text, 'OCR-only API allow-list');
forbidText(proxy, "'/api/chat'", 'OCR-only proxy must be allow-list based');

for (const text of [
  'runDocumentOcr',
  'normalizeOcrText',
  "ocr_status: 'done'",
  'ocr_text_raw: ocrText',
  'raw_provider_json_written: false',
  'articles_created: 0',
  ".in('ocr_status', ['queued', 'failed'])"
]) requireText(ocrRoute, text, 'OCR-only route');
for (const text of ['segmentArticlesFromImage', 'commitSourceImageArticles', 'enrichCommittedArticles', 'ocr_json: ocr.raw']) {
  forbidText(ocrRoute, text, 'OCR-only route isolation');
}
requireText(processRoute, 'export const POST = handleOcrOnly', 'legacy process endpoint delegates only to OCR-only');

requireText(uploadPage, '<UploadFormOcrOnly />', 'upload page');
requireText(uploadPage, '538件一括OCRは実行しません', 'upload mode disclosure');
requireText(uploadPage, '/local-stock', 'free local stock entry point');
requireText(uploadForm, '/ocr-only', 'upload OCR endpoint');
forbidText(uploadForm, '/process', 'upload must not invoke full processing');
requireText(uploadForm, '1枚ずつ', 'sequential OCR');

requireText(stockApi, "select('id,batch_id,file_name,storage_path,mime_type,ocr_status,ocr_text_raw,error_message,created_at')", 'minimal stock projection');
forbidText(stockApi, ".select('*')", 'stock API must not fetch raw OCR provider JSON');
requireText(stockList, '/ocr-stock/${batch.id}', 'stock list navigation');
requireText(stockDetail, '/ocr-only', 'stock retry endpoint');
requireText(stockDetail, 'OCR本文', 'OCR text display');

for (const text of ['mj_ocr_only_cron_snapshot_v30', 'from cron.job', 'cron.unschedule', "raise exception 'ocr_only_cron_shutdown_incomplete'"]) {
  requireText(migration, text, 'Nano cron shutdown');
}
forbidText(migration.toLowerCase(), 'delete from public.', 'migration must preserve user data');
forbidText(migration.toLowerCase(), 'truncate ', 'migration must preserve user data');

console.log('OCR-only free-mode v30 invariants passed');
