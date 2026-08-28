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

requireText(mode, "process.env.MJ_PIPELINE_MODE || 'ocr_only'", 'mode defaults to low-cost locked mode');
requireText(mode, "value === 'full' ? 'full' : 'ocr_only'", 'full mode must be explicit');

for (const text of [
  "path === '/api/cloud-stock/status'",
  "path === '/api/cloud-stock/auth'",
  "path === '/api/cloud-stock/files'",
  "path === '/api/cloud-stock/upload'",
  "storage_mode: 'google_drive_neon'",
  "supabase_mode: 'legacy_frozen'",
  'ocr_execution_locked: true',
  'full_pipeline_locked: true',
  'status: 423'
]) requireText(proxy, text, 'free cloud-stock proxy allow-list');
for (const forbidden of [
  "path === '/api/batches'",
  '/api\\/ocr-stock\\/batches',
  "path === '/api/upload/start'",
  "path === '/api/upload/image'",
  '/source-images\\/[^/]+\\/ocr-only',
  "path === '/api/chat'"
]) forbidText(proxy, forbidden, 'legacy Supabase/OCR execution must be unreachable in free stock mode');

for (const text of [
  'runDocumentOcr',
  'normalizeOcrText',
  "ocr_status: 'done'",
  'ocr_text_raw: ocrText',
  'raw_provider_json_written: false',
  'articles_created: 0',
  ".in('ocr_status', ['queued', 'failed'])"
]) requireText(ocrRoute, text, 'legacy OCR-only route remains isolated if full mode is explicitly restored later');
for (const text of ['segmentArticlesFromImage', 'commitSourceImageArticles', 'enrichCommittedArticles', 'ocr_json: ocr.raw']) {
  forbidText(ocrRoute, text, 'legacy OCR-only route isolation');
}
requireText(processRoute, 'export const POST = handleOcrOnly', 'legacy process endpoint remains OCR-only internally');

requireText(uploadPage, '現在の正本ストック：Google Drive + Neon', 'new canonical upload mode');
requireText(uploadPage, 'href="/cloud-stock"', 'cloud stock entry point');
requireText(uploadPage, 'Supabaseは旧データ互換用に凍結', 'Supabase is legacy frozen');
requireText(uploadPage, '538件一括OCRはこの経路から起動しません', 'bulk OCR remains stopped');
forbidText(uploadPage, '<UploadFormOcrOnly />', 'legacy Supabase form must not be primary upload UI');

requireText(uploadForm, '/ocr-only', 'legacy upload OCR endpoint remains OCR-only in source');
forbidText(uploadForm, '/process', 'legacy upload source must not invoke full processing');
requireText(uploadForm, '1枚ずつ', 'legacy OCR source remains sequential');

requireText(stockApi, "select('id,batch_id,file_name,storage_path,mime_type,ocr_status,ocr_text_raw,error_message,created_at')", 'minimal legacy stock projection');
forbidText(stockApi, ".select('*')", 'legacy stock API must not fetch raw OCR provider JSON');
requireText(stockList, '/ocr-stock/${batch.id}', 'legacy stock list navigation remains available as source UI only');
requireText(stockDetail, '/ocr-only', 'legacy stock retry source remains OCR-only');
requireText(stockDetail, 'OCR本文', 'legacy OCR text display');

for (const text of ['mj_ocr_only_cron_snapshot_v30', 'from cron.job', 'cron.unschedule', "raise exception 'ocr_only_cron_shutdown_incomplete'"]) {
  requireText(migration, text, 'Nano cron shutdown');
}
forbidText(migration.toLowerCase(), 'delete from public.', 'migration must preserve user data');
forbidText(migration.toLowerCase(), 'truncate ', 'migration must preserve user data');

console.log('free cloud-stock proxy freeze v30 invariants passed');
