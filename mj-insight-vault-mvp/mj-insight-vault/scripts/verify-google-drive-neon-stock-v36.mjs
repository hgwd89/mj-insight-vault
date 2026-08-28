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

const cloudPage = read('app/cloud-stock/page.tsx');
const cloudBootstrap = read('components/CloudStockAutoBootstrap.tsx');
const cloudUi = read('components/CloudStockVault.tsx');
const legacyUi = read('components/LegacySupabaseImport.tsx');
const statusRoute = read('app/api/cloud-stock/status/route.ts');
const readinessRoute = read('app/api/cloud-stock/readiness/route.ts');
const authRoute = read('app/api/cloud-stock/auth/route.ts');
const uploadRoute = read('app/api/cloud-stock/upload/route.ts');
const filesRoute = read('app/api/cloud-stock/files/route.ts');
const legacyImportRoute = read('app/api/cloud-stock/import-supabase/route.ts');
const neon = read('lib/neonCloud.ts');
const drive = read('lib/googleDriveBackup.ts');
const proxy = read('proxy.ts');
const passwordGate = read('components/PasswordGate.tsx');
const uploadPage = read('app/upload/page.tsx');
const migration = read('neon/migrations/20260828093000_google_drive_neon_stock_v36.sql');

requireText(cloudPage, 'CloudStockAutoBootstrap', 'cloud stock page');
for (const text of [
  '/api/cloud-stock/auth',
  "action: 'auto'",
  'window.location.reload()',
  'CloudStockVault'
]) requireText(cloudBootstrap, text, 'automatic Neon session bootstrap');
forbidText(cloudBootstrap, 'localStorage', 'Neon session must not be stored in localStorage');

for (const text of [
  '/api/cloud-stock/auth',
  '/api/cloud-stock/upload',
  '/api/cloud-stock/files',
  'Driveへ保存してNeonへ登録',
  'Drive直置き原本をNeonへ登録',
  'クラウドストック検索',
  'OCR・分類・Reportはまだ起動しません'
]) requireText(cloudUi, text, 'cloud stock UI');
for (const forbidden of ['runDocumentOcr', 'segmentArticlesFromImage', 'commitSourceImageArticles', 'enrichCommittedArticles', '/api/source-images/']) {
  forbidText(cloudUi, forbidden, 'cloud stock UI must not start downstream');
}

for (const route of [statusRoute, authRoute, uploadRoute, filesRoute]) {
  requireText(route, 'requireAppPassword', 'cloud APIs require app password');
  forbidText(route, 'supabaseAdmin', 'cloud APIs must not depend on Supabase');
  forbidText(route, '@supabase/', 'cloud APIs must not import Supabase');
}

for (const text of [
  'deriveOwnerCredentials',
  "action === 'auto'",
  'createHash',
  'setNeonSessionCookie'
]) requireText(authRoute, text, 'server-derived Neon owner auth');
forbidText(authRoute, 'password: appPassword', 'APP_PASSWORD itself must never be sent to Neon');

for (const text of [
  'GOOGLE_DRIVE_ORIGINALS_FOLDER_ID',
  'backupImageToGoogleDrive',
  'resolveWritableGoogleDriveFolder',
  'requireNeonJwt',
  "neonDataFetch('vault_source_files",
  'drive_saved: true',
  'neon_registered: true',
  'downstream_started: false'
]) requireText(uploadRoute, text, 'Drive -> Neon ingest contract');

for (const text of [
  "neonDataFetch('rpc/vault_search_v1'",
  "neonDataFetch('vault_source_files",
  'requireNeonJwt'
]) requireText(filesRoute, text, 'Neon registry/search contract');

for (const text of [
  'HttpOnly',
  'SameSite=Lax',
  '/token',
  '/get-session',
  'authorization: `Bearer ${jwt}`',
  "GOOGLE_DRIVE_ORIGINALS_FOLDER_ID = '1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ'"
]) requireText(neon, text, 'Neon secure gateway');

for (const text of [
  'folderId?: string',
  'clientEmail',
  'inspectGoogleDriveFolder',
  'resolveWritableGoogleDriveFolder',
  'findGoogleDriveFileByName',
  'config.folderId.trim()'
]) requireText(drive, text, 'Drive canonical/fallback/idempotent resolution');

for (const text of [
  "path === '/api/cloud-stock/status'",
  "path === '/api/cloud-stock/auth'",
  "path === '/api/cloud-stock/files'",
  "path === '/api/cloud-stock/upload'",
  "path === '/api/cloud-stock/import-supabase'",
  'full_pipeline_locked: true'
]) requireText(proxy, text, 'low-cost proxy cloud-stock allow-list');
forbidText(proxy, "path === '/api/chat'", 'full downstream must remain blocked');

for (const text of [
  'supabaseAdmin.storage.from(STORAGE_BUCKET).list',
  'supabaseAdmin.storage.from(STORAGE_BUCKET).download',
  'findGoogleDriveFileByName',
  'reused: true',
  'source_deleted: false',
  'downstream_started: false',
  'MAX_BATCH_OBJECTS = 2'
]) requireText(legacyImportRoute, text, 'legacy Supabase read-only idempotent import');
for (const forbidden of [
  '.remove(',
  '.delete(',
  'runDocumentOcr',
  'segmentArticlesFromImage',
  'commitSourceImageArticles',
  'enrichCommittedArticles'
]) forbidText(legacyImportRoute, forbidden, 'legacy import must never delete source or start downstream');
for (const text of [
  'Supabase → Google Drive 移行',
  'Supabase側のデータは削除しません',
  '/api/cloud-stock/import-supabase',
  '/api/cloud-stock/files'
]) requireText(legacyUi, text, 'legacy import UI safety contract');
requireText(readinessRoute, 'probeLegacySupabaseStorage', 'public non-secret legacy storage probe');
requireText(readinessRoute, 'legacy_supabase_storage: legacyStorage', 'legacy storage readiness disclosure');

requireText(statusRoute, "storage_mode: 'google_drive_neon'", 'cloud stock status');
requireText(statusRoute, "supabase_mode: 'legacy_frozen'", 'Supabase freeze status');
requireText(statusRoute, 'resolveWritableGoogleDriveFolder', 'authenticated Drive readiness probe');
requireText(passwordGate, "fetch('/api/cloud-stock/status'", 'password gate no longer waits for Supabase');
forbidText(passwordGate, "fetch('/api/batches'", 'password gate must not use Supabase batches');
requireText(uploadPage, 'href="/cloud-stock"', 'canonical upload navigation');
forbidText(uploadPage, '<UploadFormOcrOnly />', 'Supabase upload form not rendered in canonical upload page');

for (const text of [
  'create table if not exists public.vault_source_files',
  'create table if not exists public.vault_articles',
  'create table if not exists public.vault_report_evidence',
  'enable row level security',
  'auth.user_id()',
  'security invoker',
  'vault_search_v1',
  "('storage_mode', 'google_drive_neon')",
  "('supabase_mode', 'legacy_frozen')"
]) requireText(migration, text, 'Neon reproducible schema');
forbidText(migration.toLowerCase(), 'disable row level security', 'Neon RLS must remain enabled');

console.log('Google Drive + Neon cloud stock v36 invariants passed');
