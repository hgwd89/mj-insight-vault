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

const page = read('app/local-stock/page.tsx');
const vault = read('components/LocalStockVault.tsx');
const upload = read('app/upload/page.tsx');
const canonical = read('components/DriveNeonSimpleVault.tsx');

requireText(page, 'LocalStockVault', 'local stock route');
for (const text of [
  "const DB_NAME = 'mj-insight-vault-local-stock'",
  "const STORE = 'items'",
  'indexedDB.open',
  "db.transaction(STORE, 'readwrite')",
  'putItem',
  'listItems',
  'deleteItem',
  'URL.createObjectURL',
  'navigator.storage?.estimate',
  'navigator.storage.persist',
  'Supabaseは使用していません'
]) requireText(vault, text, 'free local stock');

const saveStart = vault.indexOf('async function save()');
const migrateStart = vault.indexOf('async function migrateItems');
if (saveStart < 0 || migrateStart < 0 || migrateStart <= saveStart) {
  throw new Error('local stock migration boundary is missing');
}
const localSaveSection = vault.slice(saveStart, migrateStart);
for (const forbidden of ['fetch(', '/api/', '@supabase/', 'createClient(', 'runDocumentOcr', 'openai']) {
  forbidText(localSaveSection, forbidden, 'offline local save must remain network/API independent');
}

for (const forbidden of [
  '@supabase/',
  'createClient(',
  'runDocumentOcr',
  'segmentArticlesFromImage',
  'commitSourceImageArticles',
  'enrichCommittedArticles',
  'openai'
]) forbidText(vault, forbidden, 'local stock must not execute Supabase/OCR/downstream work');

for (const required of [
  "fetch('/api/cloud-stock/status?probe=1'",
  "fetch('/api/cloud-stock/auth'",
  "fetch('/api/cloud-stock/upload'",
  'json.drive_saved !== true || json.neon_registered !== true',
  'await deleteItem(item.id)',
  '両方の成功を確認したものだけIndexedDBから削除します'
]) requireText(vault, required, 'explicit Drive + Neon migration');

requireText(upload, 'DriveNeonSimpleVault', 'canonical upload page');
forbidText(upload, 'UploadFormOcrOnly', 'legacy Supabase upload UI must not be canonical');
for (const text of [
  'Googleドライブに保存して、MJに登録',
  '01 Originals',
  '/api/cloud-stock/sync-drive',
  '/api/cloud-stock/files',
  '未OCR画像を一括OCR'
]) requireText(canonical, text, 'canonical Drive + Neon UI');

console.log('free local stock fallback + canonical Drive Neon invariants passed');
