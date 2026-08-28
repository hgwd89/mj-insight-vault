'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const MAX_FILES = 20;
const MAX_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const DRIVE_ORIGINALS_URL = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';

type CloudRow = {
  source_file_id?: string;
  id?: string;
  drive_file_id: string;
  drive_folder_id: string;
  file_name: string;
  mime_type?: string | null;
  file_size_bytes?: number | null;
  article_date?: string | null;
  memo?: string | null;
  source_status?: string;
  ocr_status?: string;
  created_at?: string;
  matched_article_title?: string | null;
  matched_text_preview?: string | null;
};

type UploadRow = { name: string; status: string; note?: string };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error || '失敗しました');
}

async function jsonOrError(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`));
  return json;
}

async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
    throw new Error('HEIC/HEIFはJPGまたはPNGへ変換してください。');
  }

  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  const maxSide = Math.max(width, height);
  const initialScale = Math.min(1, 4200 / Math.max(1, maxSide));
  width = Math.max(1, Math.round(width * initialScale));
  height = Math.max(1, Math.round(height * initialScale));

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.pow(0.82, attempt);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('画像を処理できません。');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const quality = Math.max(0.72, 0.94 - attempt * 0.05);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('画像圧縮に失敗しました。')), 'image/jpeg', quality);
      });
      if (blob.size <= MAX_UPLOAD_BYTES || attempt === 4) {
        const base = file.name.replace(/\.[^.]+$/, '') || 'image';
        return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
      }
    }
    return file;
  } finally {
    bitmap.close();
  }
}

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function CloudStockVault() {
  const appPassword = useAppPassword();
  const [authState, setAuthState] = useState<'checking' | 'signed-out' | 'signed-in'>('checking');
  const [email, setEmail] = useState('');
  const [neonPassword, setNeonPassword] = useState('');
  const [name, setName] = useState('MJ Insight Vault');
  const [authMessage, setAuthMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [articleDate, setArticleDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CloudRow[]>([]);
  const [listMessage, setListMessage] = useState('');
  const [manualId, setManualId] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualMessage, setManualMessage] = useState('');

  const oversizedPdfs = useMemo(
    () => files.filter((file) => (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) && file.size > MAX_UPLOAD_BYTES),
    [files]
  );

  async function checkNeonSession() {
    setAuthState('checking');
    const res = await fetch('/api/cloud-stock/auth', { headers: { 'x-app-password': appPassword } });
    if (res.ok) {
      setAuthState('signed-in');
      return true;
    }
    setAuthState('signed-out');
    return false;
  }

  async function loadRows(search = query) {
    const res = await fetch(`/api/cloud-stock/files?q=${encodeURIComponent(search.trim())}`, {
      headers: { 'x-app-password': appPassword }
    });
    if (res.status === 401) {
      setAuthState('signed-out');
      setRows([]);
      throw new Error('Neonへ再ログインしてください。');
    }
    const json = await jsonOrError(res);
    setRows(Array.isArray(json.rows) ? json.rows : []);
    setListMessage(`${Array.isArray(json.rows) ? json.rows.length : 0}件`);
  }

  useEffect(() => {
    if (!appPassword) return;
    checkNeonSession()
      .then((ok) => ok ? loadRows('').catch(() => null) : null)
      .catch(() => setAuthState('signed-out'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  async function authenticate(action: 'sign-in' | 'sign-up') {
    setAuthMessage(action === 'sign-up' ? 'アカウント作成中…' : 'ログイン中…');
    try {
      const res = await fetch('/api/cloud-stock/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
        body: JSON.stringify({ action, email, password: neonPassword, name })
      });
      await jsonOrError(res);
      setAuthState('signed-in');
      setNeonPassword('');
      setAuthMessage(action === 'sign-up' ? '作成してログインしました。' : 'ログインしました。');
      await loadRows('');
    } catch (error) {
      setAuthState('signed-out');
      setAuthMessage(messageOf(error));
    }
  }

  async function signOut() {
    await fetch('/api/cloud-stock/auth', { method: 'DELETE', headers: { 'x-app-password': appPassword } }).catch(() => null);
    setAuthState('signed-out');
    setRows([]);
    setAuthMessage('Neonからログアウトしました。');
  }

  function patchUpload(index: number, patch: Partial<UploadRow>) {
    setUploadRows((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  }

  async function uploadAll() {
    if (!files.length || busy || authState !== 'signed-in') return;
    setBusy(true);
    setUploadRows(files.map((file) => ({ name: file.name, status: '待機' })));

    let succeeded = 0;
    const failed: File[] = [];

    for (let i = 0; i < files.length; i++) {
      const original = files[i];
      try {
        patchUpload(i, { status: '準備中' });
        const uploadFile = await compressImage(original);
        if (uploadFile.size > MAX_UPLOAD_BYTES) {
          throw new Error('3.5MBを超えています。Google Driveへ直接追加し、下の「Drive直置き原本をNeonへ登録」を使ってください。');
        }

        const form = new FormData();
        form.set('file', uploadFile);
        form.set('memo', memo);
        form.set('article_date', articleDate);
        patchUpload(i, { status: 'Drive保存→Neon登録', note: formatBytes(uploadFile.size) });

        const res = await fetch('/api/cloud-stock/upload', {
          method: 'POST',
          headers: { 'x-app-password': appPassword },
          body: form
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (json.drive_saved && json.recovery?.drive_file_id) {
            throw new Error(`Drive保存済み・Neon登録のみ失敗。Drive ID: ${json.recovery.drive_file_id} / ${json.error || ''}`);
          }
          throw new Error(String(json.error || `HTTP ${res.status}`));
        }
        succeeded += 1;
        patchUpload(i, { status: '完了', note: 'Google Drive原本 + Neon索引' });
      } catch (error) {
        failed.push(original);
        patchUpload(i, { status: '失敗', note: messageOf(error) });
      }
    }

    setFiles(failed);
    setBusy(false);
    setListMessage(`保存完了 ${succeeded}件 / 失敗 ${failed.length}件`);
    await loadRows('').catch((error) => setListMessage(messageOf(error)));
  }

  async function registerManual() {
    setManualMessage('登録中…');
    try {
      const res = await fetch('/api/cloud-stock/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
        body: JSON.stringify({
          drive_file_id: manualId.trim(),
          file_name: manualName.trim(),
          memo,
          article_date: articleDate
        })
      });
      await jsonOrError(res);
      setManualId('');
      setManualName('');
      setManualMessage('Neonへ登録しました。');
      await loadRows('');
    } catch (error) {
      setManualMessage(messageOf(error));
    }
  }

  if (authState !== 'signed-in') {
    return (
      <div className="space-y-4">
        <div className="card p-5">
          <h1 className="text-xl font-black">クラウドストック初回ログイン</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-600">
            Google Driveを原本、Neonを検索DBとして使います。Neonの無料アカウント用メールアドレスとパスワードは初回だけ設定してください。
            セッションはHttpOnly Cookieで保持し、DBトークンはブラウザ保存しません。
          </p>
          <div className="mt-4 grid gap-3">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="メールアドレス" />
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="表示名" />
            <input className="input" type="password" value={neonPassword} onChange={(e) => setNeonPassword(e.target.value)} placeholder="Neon用パスワード" />
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" type="button" onClick={() => authenticate('sign-in')} disabled={!email || !neonPassword || authState === 'checking'}>ログイン</button>
              <button className="btn" type="button" onClick={() => authenticate('sign-up')} disabled={!email || !neonPassword || authState === 'checking'}>初回アカウント作成</button>
            </div>
            {authMessage && <p className="text-sm text-zinc-700">{authMessage}</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-black">Google Drive + Neon クラウドストック</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              原本をGoogle Driveへ保存し、同じ処理でNeonへ検索索引を登録します。OCR・分類・Reportはまだ起動しません。
            </p>
          </div>
          <button className="btn" type="button" onClick={signOut}>Neonログアウト</button>
        </div>

        <div className="mt-4 grid gap-3">
          <textarea className="input min-h-20" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ（任意）" />
          <input className="input" type="date" value={articleDate} onChange={(e) => setArticleDate(e.target.value)} />
          <input className="input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" multiple disabled={busy} onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, MAX_FILES))} />
          <p className="text-sm text-zinc-600">選択 {files.length}件 / 一度に最大{MAX_FILES}件。画像はブラウザで圧縮し、1件ずつ安全に保存します。</p>
          {oversizedPdfs.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              3.5MB超のPDFがあります。Vercel無料枠を通さず、Google Driveへ直接置いてから下の手動登録を使ってください。
            </div>
          )}
          <button className="btn btn-primary" type="button" onClick={uploadAll} disabled={!files.length || busy}>
            {busy ? '1件ずつ保存中…' : 'Driveへ保存してNeonへ登録'}
          </button>
        </div>

        {uploadRows.length > 0 && (
          <div className="mt-4 max-h-72 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
            {uploadRows.map((row, i) => (
              <div key={`${row.name}-${i}`} className="border-b border-zinc-200 py-2 last:border-0">
                <b>{i + 1}. {row.name}</b> <span className="badge ml-2">{row.status}</span>
                {row.note && <p className="mt-1 text-xs text-zinc-600">{row.note}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="font-bold">Drive直置き原本をNeonへ登録</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">大きいPDFなどをDriveへ直接追加した場合に使います。Drive URLの `/d/` または `file/d/` の後にあるファイルIDとファイル名を登録してください。</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <input className="input" value={manualId} onChange={(e) => setManualId(e.target.value)} placeholder="Google Drive file ID" />
          <input className="input" value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="ファイル名.pdf" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={registerManual} disabled={!manualId.trim() || !manualName.trim()}>Neonへ索引登録</button>
          <a className="btn" href={DRIVE_ORIGINALS_URL} target="_blank" rel="noreferrer">01 Originalsを開く</a>
        </div>
        {manualMessage && <p className="mt-2 text-sm text-zinc-700">{manualMessage}</p>}
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-bold">クラウドストック検索</h2>
          <span className="text-sm text-zinc-500">{listMessage}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <input className="input flex-1" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadRows().catch((error) => setListMessage(messageOf(error))); }} placeholder="ファイル名・メモ・将来のOCR本文を検索" />
          <button className="btn btn-primary" type="button" onClick={() => loadRows().catch((error) => setListMessage(messageOf(error)))}>検索</button>
          <button className="btn" type="button" onClick={() => { setQuery(''); loadRows('').catch((error) => setListMessage(messageOf(error))); }}>全件</button>
        </div>

        <div className="mt-4 space-y-2">
          {rows.map((row) => (
            <div key={row.source_file_id || row.id || row.drive_file_id} className="rounded-xl border border-zinc-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <b>{row.file_name}</b>
                  <p className="mt-1 text-xs text-zinc-500">{row.article_date || '日付未設定'} / {formatBytes(row.file_size_bytes)} / OCR: {row.ocr_status || 'not_started'}</p>
                </div>
                <a className="btn" href={`https://drive.google.com/file/d/${encodeURIComponent(row.drive_file_id)}/view`} target="_blank" rel="noreferrer">原本</a>
              </div>
              {row.memo && <p className="mt-2 text-sm text-zinc-700">{row.memo}</p>}
              {row.matched_article_title && <p className="mt-2 text-sm"><b>記事:</b> {row.matched_article_title}</p>}
              {row.matched_text_preview && <p className="mt-1 line-clamp-3 text-xs leading-5 text-zinc-600">{row.matched_text_preview}</p>}
            </div>
          ))}
          {!rows.length && <p className="text-sm text-zinc-500">登録データはまだありません。</p>}
        </div>
      </div>
    </div>
  );
}
