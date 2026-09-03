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

const route = read('app/api/cloud-stock/import-supabase/route.ts');
const page = read('app/legacy-import/page.tsx');
const proxy = read('proxy.ts');
const legacyStatusRoute = read('app/api/cloud-stock/legacy-status/route.ts');
const migration = read('neon/migrations/20260828214500_legacy_source_provenance_v37.sql');

for (const text of [
  'Supabase integration is retired',
  'status: 410',
  "storage_mode: 'google_drive_neon'",
  'source_deleted: false',
  'downstream_started: false'
]) requireText(route, text, 'retired Supabase Storage route');
for (const forbidden of [
  'supabaseAdmin',
  '@supabase/',
  '.download(',
  '.list(',
  '.remove(',
  'runDocumentOcr',
  'segmentArticlesFromImage'
]) forbidText(route, forbidden, 'retired Supabase Storage route must be inert');

requireText(page, 'Supabase連携は退役しました', 'legacy page retirement notice');
requireText(page, 'Google Drive + Neon', 'canonical runtime notice');

requireText(proxy, "path === '/api/cloud-stock/import-supabase'", 'proxy must pass retired route to its 410 tombstone');
requireText(proxy, "path === '/api/cloud-stock/legacy-status'", 'historical Neon-only rescue status remains readable');
forbidText(legacyStatusRoute, 'supabaseAdmin', 'legacy status must remain Neon-only');

for (const text of [
  'legacy_source_provider',
  'legacy_source_bucket',
  'legacy_source_path',
  'legacy_source_sha256',
  'legacy_copy_verified_at',
  'legacy_source_deleted_at'
]) requireText(migration, text, 'historical provenance schema remains preserved');
forbidText(migration.toLowerCase(), 'drop table', 'historical provenance migration must remain additive');

console.log('Supabase Storage retirement invariants passed');
