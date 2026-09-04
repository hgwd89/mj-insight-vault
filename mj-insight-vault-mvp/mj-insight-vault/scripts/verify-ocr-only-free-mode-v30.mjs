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
const statusRoute = read('app/api/cloud-stock/status/route.ts');
const uploadPage = read('app/upload/page.tsx');
const retiredStorageRoute = read('app/api/cloud-stock/import-supabase/route.ts');
const retiredDbRoute = read('app/api/cloud-stock/import-supabase-db/route.ts');
const retiredArticlesRoute = read('app/api/articles/route.ts');
const originalContentRoute = read('app/api/cloud-stock/files/[id]/content/route.ts');

// Pipeline mode may remain for historical/internal code, but it must not be able to reopen legacy runtime APIs.
requireText(mode, "process.env.MJ_PIPELINE_MODE || 'ocr_only'", 'legacy mode helper remains explicit');
forbidText(proxy, 'isOcrOnlyMode', 'runtime allowlist must not be bypassed by pipeline mode');

for (const text of [
  "path === '/api/cloud-stock/readiness'",
  "path === '/api/cloud-stock/status'",
  "path === '/api/cloud-stock/auth'",
  "path === '/api/cloud-stock/files'",
  "path.startsWith('/api/cloud-stock/files/')",
  "path === '/api/cloud-stock/upload'",
  "path === '/api/cloud-stock/sync-drive'",
  "path === '/api/cloud-stock/ocr'",
  "path === '/api/cloud-stock/articles'",
  "path === '/api/cloud-stock/import-supabase'",
  "path === '/api/cloud-stock/import-supabase-db'",
  'retired: true',
  'classification_locked: true',
  'theme_analysis_locked: true',
  'report_locked: true',
  'bulk_processing_locked: true',
  'status: 423'
]) requireText(proxy, text, 'permanent Drive + Neon runtime contract');

for (const forbidden of [
  "path === '/api/batches'",
  "path === '/api/upload/start'",
  "path === '/api/upload/image'",
  "path === '/api/chat'",
  "path === '/api/articles'",
  "path === '/api/signed-url'"
]) forbidText(proxy, forbidden, 'legacy/Supabase runtime routes must stay blocked');

requireText(statusRoute, "storage_mode: 'google_drive_neon'", 'canonical storage mode');
requireText(statusRoute, "supabase_mode: 'retired'", 'Supabase runtime retirement');
requireText(statusRoute, 'full_rollout_538: false', '538 rollout lock');

requireText(uploadPage, 'DriveNeonSimpleVault', 'canonical upload page');
forbidText(uploadPage, 'UploadFormOcrOnly', 'legacy Supabase upload UI must not be canonical');

for (const route of [retiredStorageRoute, retiredDbRoute, retiredArticlesRoute]) {
  requireText(route, 'status: 410', 'retired Supabase route must be a tombstone');
  forbidText(route, 'supabaseAdmin', 'retired Supabase route must not call Supabase');
  forbidText(route, '@supabase/', 'retired Supabase route must not import Supabase');
}

for (const text of [
  'requireAppPassword',
  'requireNeonJwt',
  'downloadGoogleDriveFile',
  'drive_file_id'
]) requireText(originalContentRoute, text, 'linked original must be served only through Drive + Neon');
forbidText(originalContentRoute, 'supabaseAdmin', 'original content must never fall back to Supabase');

console.log('Permanent Google Drive + Neon runtime invariants passed');
