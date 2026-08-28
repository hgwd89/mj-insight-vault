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

const importRoute = read('app/api/cloud-stock/import-supabase/route.ts');
const filesRoute = read('app/api/cloud-stock/files/route.ts');
const legacyStatusRoute = read('app/api/cloud-stock/legacy-status/route.ts');
const legacyUi = read('components/LegacySupabaseImport.tsx');
const integrity = read('lib/googleDriveIntegrity.ts');
const migration = read('neon/migrations/20260828214500_legacy_source_provenance_v37.sql');
const proxy = read('proxy.ts');

for (const text of [
  "createHash('sha256').update(buffer).digest('hex')",
  'hashGoogleDriveFile',
  'verified.sha256 !== sourceSha256',
  'verified.size !== buffer.length',
  'content_verified: true',
  'source_sha256: sourceSha256',
  'source_deleted: false',
  'downstream_started: false'
]) requireText(importRoute, text, 'legacy import route');
for (const forbidden of ['.remove(', '.delete(', "method: 'DELETE'", 'runDocumentOcr', 'segmentArticlesFromImage']) {
  forbidText(importRoute, forbidden, 'legacy import must remain read-only at source and downstream-closed');
}

for (const text of [
  'legacy_source_provider',
  'legacy_source_bucket',
  'legacy_source_path',
  'legacy_source_sha256',
  'legacy_copy_verified_at',
  'on_conflict=drive_file_id',
  'resolution=merge-duplicates,return=representation',
  'Legacy source provenance is incomplete or unverified.'
]) requireText(filesRoute, text, 'Neon provenance upsert');

for (const text of [
  'legacy_source_provider=eq.supabase_storage',
  'legacy_copy_verified_at',
  'legacy_source_deleted_at',
  'deletion_released: false',
  'retained_in_supabase'
]) requireText(legacyStatusRoute, text, 'persistent rescue status');
forbidText(legacyStatusRoute, 'supabaseAdmin', 'legacy status must be Neon-only');

for (const text of [
  "row.content_verified !== true",
  'row.drive_sha256 !== row.source_sha256',
  "legacy_source_provider: 'supabase_storage'",
  'legacy_copy_verified: true',
  '/api/cloud-stock/legacy-status',
  'Neon退避状況を確認',
  '削除release:',
  'SHA-256'
]) requireText(legacyUi, text, 'legacy rescue UI');

for (const text of [
  'alt=media',
  "createHash('sha256').update(buffer).digest('hex')",
  'GOOGLE_CLOUD_CREDENTIALS'
]) requireText(integrity, text, 'Drive integrity verifier');

for (const text of [
  'legacy_source_provider',
  'legacy_source_bucket',
  'legacy_source_path',
  'legacy_source_sha256',
  'legacy_copy_verified_at',
  'legacy_source_deleted_at',
  'vault_source_files_legacy_source_uidx'
]) requireText(migration, text, 'Neon legacy provenance migration');
forbidText(migration.toLowerCase(), 'drop table', 'legacy provenance migration must be additive');

requireText(proxy, "path === '/api/cloud-stock/legacy-status'", 'low-cost proxy must allow read-only rescue status');
forbidText(proxy, "path === '/api/chat'", 'full pipeline must remain locked');

console.log('Legacy Supabase rescue v37 invariants passed');
