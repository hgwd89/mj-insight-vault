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

for (const forbidden of [
  'fetch(',
  '@supabase/',
  'createClient(',
  '/api/',
  'runDocumentOcr',
  'segmentArticlesFromImage',
  'commitSourceImageArticles',
  'enrichCommittedArticles',
  'openai'
]) forbidText(vault, forbidden, 'free local stock must be network/API independent');

requireText(upload, '無料ストック優先モード', 'upload free-mode disclosure');
requireText(upload, 'Supabaseを復旧・課金しなくても', 'no-paid-recovery disclosure');
requireText(upload, 'href="/local-stock"', 'free local stock navigation');
requireText(upload, '538件一括OCRは実行しません', 'bulk OCR remains stopped');

console.log('free local stock v35 invariants passed');
