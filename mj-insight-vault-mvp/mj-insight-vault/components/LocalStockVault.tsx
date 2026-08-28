'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DB_NAME = 'mj-insight-vault-local-stock';
const DB_VERSION = 1;
const STORE = 'items';
const MAX_FILES = 100;
const MAX_CLOUD_UPLOAD_BYTES = 3.5 * 1024 * 1024;

type StockItem = {
  id: string;
  name: string;
  type: string;
  size: number;
  memo: string;
  articleDate: string;
  createdAt: string;
  blob: Blob;
};

type StorageState = {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
};

type MigrationState = Record<string, { status: string; note?: string }>;

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB error'));
  });
}

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

async function listItems(): Promise<StockItem[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const rows = await idbRequest(tx.objectStore(STORE).getAll() as IDBRequest<StockItem[]>);
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

async function putItem(item: StockItem) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await idbRequest(tx.objectStore(STORE).put(item));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('保存に失敗しました'));
      tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
    });
  } finally {
    db.close();
  }
}

async function deleteItem(id: string) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('削除に失敗しました'));
    });
  } finally {
    db.close();
  }
}

function formatBytes(value: number | null) {
  if (value == null) return '取得不能';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '失敗しました');
}

async function ensureCloudSession(appPassword: string) {
  const check = await fetch('/api/cloud-stock/auth', { headers: { 'x-app-password': appPassword } });
  if (check.ok) return;

  const bootstrap = await fetch('/api/cloud-stock/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
    body: JSON.stringify({ action: 'auto' })
  });
  if (!bootstrap.ok) {
    const json = await bootstrap.json().catch(() => ({}));
    throw new Error(String(json.error || `Neonセッション作成失敗 HTTP ${bootstrap.status}`));
  }
}

async function cloudReady(appPassword: string) {
  const res = await fetch('/api/cloud-stock/status?probe=1', { headers: { 'x-app-password': appPassword } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.drive?.writable !== true || json?.neon?.data_api_configured !== true) {
    throw new Error(String(json?.drive?.probe_error || json?.error || 'Google Drive / Neon がまだ利用可能ではありません。'));
  }
}

async function prepareLocalItemForCloud(item: StockItem): Promise<File> {
  const type = (item.type || item.blob.type || 'application/octet-stream').toLowerCase();
  const isPdf = type === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf');
  const original = new File([item.blob], item.name, { type: isPdf ? 'application/pdf' : type });

  if (isPdf) {
    if (original.size > MAX_CLOUD_UPLOAD_BYTES) {
      throw new Error('3.5MB超のPDFです。自動移行対象外のためローカルに残しました。');
    }
    return original;
  }

  if (!type.startsWith('image/')) throw new Error('画像/PDF以外のため移行できません。');
  if (/heic|heif/i.test(type) || /\.hei[cf]$/i.test(item.name)) {
    throw new Error('HEIC/HEIFはJPGまたはPNGへ変換してから移行してください。');
  }
  if (original.size <= MAX_CLOUD_UPLOAD_BYTES && ['image/jpeg', 'image/png', 'image/webp'].includes(type)) return original;

  const bitmap = await createImageBitmap(original);
  let width = bitmap.width;
  let height = bitmap.height;
  const maxSide = Math.max(width, height);
  const initialScale = Math.min(1, 4200 / Math.max(1, maxSide));
  width = Math.max(1, Math.round(width * initialScale));
  height = Math.max(1, Math.round(height * initialScale));

  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.pow(0.8, attempt);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('画像を処理できません。');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const quality = Math.max(0.68, 0.94 - attempt * 0.05);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('画像圧縮に失敗しました。')), 'image/jpeg', quality);
      });
      if (blob.size <= MAX_CLOUD_UPLOAD_BYTES) {
        const base = item.name.replace(/\.[^.]+$/, '') || 'image';
        return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
      }
    }
  } finally {
    bitmap.close();
  }

  throw new Error('画像を3.5MB以下へ安全に圧縮できませんでした。ローカルに残しました。');
}

export function LocalStockVault() {
  const appPassword = useAppPassword();
  const [items, setItems] = useState<StockItem[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [articleDate, setArticleDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [message, setMessage] = useState('');
  const [migration, setMigration] = useState<MigrationState>({});
  const [storage, setStorage] = useState<StorageState>({ usage: null, quota: null, persisted: null });

  const selectedBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const storedBytes = useMemo(() => items.reduce((sum, item) => sum + item.size, 0), [items]);

  async function refresh() {
    const [rows, estimate, persisted] = await Promise.all([
      listItems(),
      navigator.storage?.estimate?.().catch(() => null),
      navigator.storage?.persisted?.().catch(() => null),
    ]);
    setItems(rows);
    setStorage({
      usage: estimate?.usage ?? null,
      quota: estimate?.quota ?? null,
      persisted: typeof persisted === 'boolean' ? persisted : null,
    });
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(errorMessage(error)));
  }, []);

  async function requestPersistence() {
    if (!navigator.storage?.persist) {
      setMessage('このブラウザは永続ストレージ要求に対応していません。');
      return;
    }
    const granted = await navigator.storage.persist();
    await refresh();
    setMessage(granted ? '永続ストレージが許可されました。' : '永続ストレージは許可されませんでした。ブラウザのサイトデータ削除には注意してください。');
  }

  async function save() {
    if (!files.length || busy || migrating) return;
    setBusy(true);
    setMessage('ブラウザ内へ保存中…');
    try {
      for (const file of files) {
        const id = `${Date.now()}-${crypto.randomUUID()}`;
        await putItem({
          id,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          memo: memo.trim(),
          articleDate: articleDate.trim(),
          createdAt: new Date().toISOString(),
          blob: file,
        });
      }
      const savedCount = files.length;
      setFiles([]);
      setMessage(`${savedCount}件を無料ローカルストックへ保存しました。Supabaseは使用していません。`);
      await refresh();
    } catch (error) {
      setMessage(`保存失敗：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function migrateItems(targets: StockItem[]) {
    if (!targets.length || migrating || busy) return;
    setMigrating(true);
    setMessage('Google Drive + Neonへの移行準備中…');
    let succeeded = 0;
    let failed = 0;

    try {
      await cloudReady(appPassword);
      await ensureCloudSession(appPassword);

      for (const item of targets) {
        setMigration((current) => ({ ...current, [item.id]: { status: '移行中' } }));
        try {
          const uploadFile = await prepareLocalItemForCloud(item);
          const form = new FormData();
          form.set('file', uploadFile);
          form.set('memo', item.memo || '');
          form.set('article_date', item.articleDate || '');

          const res = await fetch('/api/cloud-stock/upload', {
            method: 'POST',
            headers: { 'x-app-password': appPassword },
            body: form
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || json.drive_saved !== true || json.neon_registered !== true) {
            const partial = json.drive_saved === true ? 'Drive保存済み・Neon登録未完了。ローカル原本は削除していません。' : '';
            throw new Error(`${json.error || `HTTP ${res.status}`} ${partial}`.trim());
          }

          await deleteItem(item.id);
          succeeded += 1;
          setMigration((current) => ({ ...current, [item.id]: { status: '完了', note: 'Drive + Neon確認後にローカル削除' } }));
        } catch (error) {
          failed += 1;
          setMigration((current) => ({ ...current, [item.id]: { status: '失敗', note: errorMessage(error) } }));
        }
      }

      setMessage(`移行完了：${succeeded}件成功 / ${failed}件失敗。成功分だけローカルから削除しました。`);
      await refresh();
    } catch (error) {
      setMessage(`移行開始できません：${errorMessage(error)}`);
    } finally {
      setMigrating(false);
    }
  }

  function download(item: StockItem) {
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function remove(id: string) {
    await deleteItem(id);
    setMessage('削除しました。');
    await refresh();
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h1 className="text-xl font-black">無料ローカルストック</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Supabase・外部DB・OCR APIを使わず、画像ファイルをこのブラウザのIndexedDBへ保存します。料金は発生しません。
          現在はGoogle Drive + Neonが正規のクラウド保存先です。ここに残っている旧ローカル原本は下の移行ボタンで移せます。
        </p>
      </div>

      <div className="card p-5">
        <h2 className="font-bold">保存容量</h2>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-4">
          <div className="rounded-xl bg-zinc-50 p-3"><b>{items.length}</b><br />保存件数</div>
          <div className="rounded-xl bg-zinc-50 p-3"><b>{formatBytes(storedBytes)}</b><br />Vault内ファイル合計</div>
          <div className="rounded-xl bg-zinc-50 p-3"><b>{formatBytes(storage.usage)} / {formatBytes(storage.quota)}</b><br />ブラウザ使用量 / 推定上限</div>
          <div className="rounded-xl bg-zinc-50 p-3"><b>{storage.persisted === true ? '永続化済み' : storage.persisted === false ? '未永続化' : '不明'}</b><br />Storage persistence</div>
        </div>
        {storage.persisted !== true && <button className="btn mt-3" type="button" onClick={requestPersistence}>永続ストレージを要求</button>}
      </div>

      <div className="card p-5">
        <h2 className="font-bold">保存済みローカル原本をクラウドへ移行</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Google Drive `01 Originals` へ原本を保存し、Neonへ検索索引を登録します。両方の成功を確認したものだけIndexedDBから削除します。
          3.5MB超のPDFはVercel無料枠を通せないため自動移行せず、そのままローカルに残します。
        </p>
        <button className="btn btn-primary mt-3" type="button" disabled={!items.length || migrating || busy} onClick={() => migrateItems(items)}>
          {migrating ? '1件ずつ移行中…' : `保存済み${items.length}件をDrive + Neonへ移行`}
        </button>
      </div>

      <div className="card p-5">
        <h2 className="font-bold">画像を追加</h2>
        <div className="mt-4 space-y-3">
          <textarea className="input min-h-20" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ：例 2026年8月 / 新聞ストック" />
          <input className="input" value={articleDate} onChange={(e) => setArticleDate(e.target.value)} placeholder="記事日付：例 2026-08-28（任意）" />
          <input className="input" type="file" accept="image/*,.pdf" multiple disabled={busy || migrating} onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, MAX_FILES))} />
          <p className="text-sm text-zinc-600">選択 {files.length}件 / {formatBytes(selectedBytes)}。1回最大{MAX_FILES}件。</p>
          <button className="btn btn-primary" type="button" disabled={!files.length || busy || migrating} onClick={save}>{busy ? '保存中' : '無料ローカルへ保存'}</button>
          {message && <p className="text-sm leading-6 text-zinc-700">{message}</p>}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="font-bold">保存済み</h2>
        <div className="mt-3 grid gap-3">
          {items.length === 0 && <p className="text-sm text-zinc-500">ローカル保存は空です。移行済みならGoogle Drive + Neon側にあります。</p>}
          {items.map((item) => {
            const state = migration[item.id];
            return (
              <div key={item.id} className="rounded-xl border border-zinc-200 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <b className="break-all">{item.name}</b>
                    <p className="mt-1 text-xs text-zinc-500">{new Date(item.createdAt).toLocaleString('ja-JP')} / {formatBytes(item.size)}{item.articleDate ? ` / ${item.articleDate}` : ''}</p>
                    {item.memo && <p className="mt-2 text-sm text-zinc-600">{item.memo}</p>}
                    {state && <p className="mt-2 text-xs text-zinc-700"><b>{state.status}</b>{state.note ? `：${state.note}` : ''}</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button className="btn" type="button" disabled={migrating || busy} onClick={() => migrateItems([item])}>Driveへ移行</button>
                    <button className="btn" type="button" onClick={() => download(item)}>取り出す</button>
                    <button className="btn" type="button" disabled={migrating} onClick={() => remove(item.id)}>削除</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
