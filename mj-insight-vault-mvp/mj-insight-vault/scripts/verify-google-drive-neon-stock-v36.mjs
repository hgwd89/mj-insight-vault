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

const cloudUi = read('components/CloudStockVault.tsx');
const simpleVault = read('components/DriveNeonSimpleVault.tsx');
const statusRoute = read('app/api/cloud-stock/status/route.ts');
const readinessRoute = read('app/api/cloud-stock/readiness/route.ts');
const authRoute = read('app/api/cloud-stock/auth/route.ts');
const uploadRoute = read('app/api/cloud-stock/upload/route.ts');
const filesRoute = read('app/api/cloud-stock/files/route.ts');
const drive = read('lib/googleDriveBackup.ts');
const neon = read('lib/neonCloud.ts');
const retiredStorageRoute = read('app/api/cloud-stock/import-supabase/route.ts');
const retiredDbRoute = read('app/api/cloud-stock/import-supabase-db/route.ts');
const legacyPage = read('app/legacy-import/page.tsx');

for (const route of [statusRoute, authRoute, uploadRoute, filesRoute]) {
  requireText(route, 'requireAppPassword', 'canonical cloud APIs require app password');
  forbidText(route, 'supabaseAdmin', 'canonical cloud APIs must not depend on Supabase');
  forbidText(route, '@supabase/', 'canonical cloud APIs must not import Supabase');
}

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
  'const MAX_UPLOAD_FILES = 100;',
  'const UPLOAD_CONCURRENCY = 3;',
  "fetch('/api/cloud-stock/upload'",
  'selectedFiles.slice(index, index + UPLOAD_CONCURRENCY)',
  'setSelectedFiles(failedFiles)',
  '最大100件',
  'multiple'
]) requireText(simpleVault, text, '100-file direct upload contract');
for (const forbidden of ['@supabase/', 'supabaseAdmin']) {
  forbidText(simpleVault, forbidden, 'direct upload UI must remain Supabase-free');
}

for (const text of [
  "neonDataFetch('rpc/vault_search_v1'",
  "neonDataFetch('vault_source_files",
  'requireNeonJwt'
]) requireText(filesRoute, text, 'Neon registry/search contract');

for (const text of [
  'inspectGoogleDriveFolder',
  'resolveWritableGoogleDriveFolder',
  'canAddChildren',
  'backupImageToGoogleDrive'
]) requireText(drive, text, 'Drive writable/upload contract');

for (const text of [
  'HttpOnly',
  'SameSite=Lax',
  'authorization: `Bearer ${jwt}`'
]) requireText(neon, text, 'Neon secure gateway');

requireText(readinessRoute, "storage_mode: 'google_drive_neon'", 'readiness canonical storage mode');
forbidText(readinessRoute, 'supabaseAdmin', 'readiness must not call Supabase');
forbidText(readinessRoute, 'probeLegacySupabaseStorage', 'readiness must not wait for Supabase');

requireText(statusRoute, "storage_mode: 'google_drive_neon'", 'status canonical storage mode');
requireText(statusRoute, "supabase_mode: 'retired'", 'Supabase retirement status');
requireText(statusRoute, 'resolveWritableGoogleDriveFolder', 'authenticated Drive writable probe');
requireText(statusRoute, 'full_rollout_538: false', '538 rollout remains locked');

for (const route of [retiredStorageRoute, retiredDbRoute]) {
  requireText(route, 'status: 410', 'Supabase retirement tombstone');
  forbidText(route, 'supabaseAdmin', 'retired route must not call Supabase');
}
requireText(legacyPage, 'Supabase連携は退役しました', 'legacy page retirement notice');

for (const forbidden of ['runDocumentOcr', 'segmentArticlesFromImage', 'commitSourceImageArticles', 'enrichCommittedArticles']) {
  forbidText(cloudUi, forbidden, 'cloud stock UI must not start downstream');
}

console.log('Google Drive + Neon runtime invariants passed after Supabase retirement');
