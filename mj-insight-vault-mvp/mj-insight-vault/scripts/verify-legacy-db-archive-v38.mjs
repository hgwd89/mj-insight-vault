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

const route = read('app/api/cloud-stock/import-supabase-db/route.ts');
const page = read('app/legacy-import/page.tsx');
const proxy = read('proxy.ts');
const migration = read('neon/migrations/20260828215500_legacy_json_archive_v38.sql');

for (const text of [
  'Supabase integration is retired',
  'status: 410',
  "storage_mode: 'google_drive_neon'",
  'source_deleted: false',
  'downstream_started: false'
]) requireText(route, text, 'retired Supabase DB route');
for (const forbidden of [
  'supabaseAdmin',
  '@supabase/',
  '.select(',
  '.range(',
  'vault_archive_legacy_json_v1',
  'runDocumentOcr',
  'openai'
]) forbidText(route, forbidden, 'retired Supabase DB route must be inert');

requireText(page, 'Supabase連携は退役しました', 'legacy page retirement notice');
requireText(page, 'Google Drive + Neon', 'canonical runtime notice');
requireText(proxy, "path === '/api/cloud-stock/import-supabase-db'", 'proxy must pass retired DB route to its 410 tombstone');

for (const text of [
  'create table if not exists public.vault_legacy_json_archive',
  'payload jsonb not null',
  'payload_sha256 text not null',
  'vault_archive_legacy_json_v1',
  'vault_legacy_archive_status_v1'
]) requireText(migration, text, 'historical Neon archive schema remains preserved');
forbidText(migration.toLowerCase(), 'drop table', 'historical archive migration must remain additive');

console.log('Supabase DB retirement invariants passed');
