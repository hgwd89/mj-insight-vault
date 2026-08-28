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
  '画像ファイルをこのブラウザのIndexedDBへ保存します',
  '料金は発生しません',
  'Supabaseは使用していません',
  'accept="image/*,.pdf"'
]) requireText(vault, text, 'free local stock');

// Local save itself must remain network/API independent. Network access is allowed only
// in the explicit migration path that moves already-saved originals to Drive + Neon.
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
  '両方の成功を確認したものだけIndexedDBから削除します',
  '3.5MB超のPDFはVercel無料枠を通せないため自動移行せず'
]) requireText(vault, required, 'explicit Drive + Neon migration');

requireText(upload, '現在の正本ストック：Google Drive + Neon', 'canonical cloud stock disclosure');
requireText(upload, 'href="/cloud-stock"', 'canonical cloud stock navigation');
requireText(upload, 'href="/local-stock"', 'local fallback remains reachable');
requireText(upload, '非常用ローカル退避', 'local stock must be explicitly fallback-only');
requireText(upload, '538件一括OCRはこの経路から起動しません', 'bulk OCR remains stopped');

console.log('free local stock v35 fallback + explicit migration invariants passed');
