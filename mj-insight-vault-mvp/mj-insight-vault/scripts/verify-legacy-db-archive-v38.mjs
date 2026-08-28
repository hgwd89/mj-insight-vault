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
function forbidPattern(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`${label}: forbidden pattern ${pattern}`);
}

const route = read('app/api/cloud-stock/import-supabase-db/route.ts');
const ui = read('components/LegacySupabaseDbArchive.tsx');
const page = read('app/legacy-import/page.tsx');
const proxy = read('proxy.ts');
const migration = read('neon/migrations/20260828215500_legacy_json_archive_v38.sql');

for (const table of [
  'articles',
  'article_tags',
  'article_profiles',
  'analysis_categories',
  'article_category_memberships',
  'source_page_article_inventory_jobs_v1',
  'chat_reports',
  'full_corpus_scan_runs',
  'formal_corpus_articles_v1',
  'concept_clusters'
]) requireText(route, `'${table}'`, 'essential Supabase rescue allow-list');

for (const text of [
  'const MAX_PAGE = 25',
  '.select(\'*\')',
  '.range(offset, offset + limit - 1)',
  "createHash('sha256')",
  'canonicalJson',
  "rpc/vault_archive_legacy_json_v1",
  'source_deleted: false',
  'downstream_started: false'
]) requireText(route, text, 'essential DB archive route');

for (const pattern of [
  /supabaseAdmin[\s\S]{0,400}\.delete\(/,
  /supabaseAdmin[\s\S]{0,400}\.update\(/,
  /supabaseAdmin[\s\S]{0,400}\.insert\(/,
  /supabaseAdmin[\s\S]{0,400}\.upsert\(/,
  /supabaseAdmin[\s\S]{0,400}storage[\s\S]{0,300}\.remove\(/
]) forbidPattern(route, pattern, 'Supabase DB rescue must remain source-read-only');
for (const forbidden of [
  "method: 'DELETE'",
  'runDocumentOcr',
  'segmentArticlesFromImage',
  'openai'
]) forbidText(route, forbidden, 'Supabase DB rescue must remain downstream-closed');

for (const text of [
  '/api/cloud-stock/import-supabase-db',
  '必須DBデータをNeonへ退避',
  'Supabase側は読み取りのみ',
  '失敗テーブルはSupabase復旧後に再実行できます'
]) requireText(ui, text, 'essential DB rescue UI');
requireText(page, 'LegacySupabaseDbArchive', 'legacy import page must expose DB rescue');
requireText(proxy, "path === '/api/cloud-stock/import-supabase-db'", 'low-cost proxy must allow DB rescue only');

for (const text of [
  'create table if not exists public.vault_legacy_json_archive',
  'payload jsonb not null',
  'payload_sha256 text not null',
  'enable row level security',
  'auth.user_id()',
  'vault_archive_legacy_json_v1',
  'on conflict (user_id, source_table, source_pk)',
  'vault_legacy_archive_status_v1'
]) requireText(migration, text, 'Neon legacy JSON archive migration');
forbidText(migration.toLowerCase(), 'drop table', 'legacy JSON archive migration must be additive');

console.log('Legacy Supabase DB archive v38 invariants passed');
