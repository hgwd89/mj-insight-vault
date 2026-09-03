'use client';

import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DRIVE_URL = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';

type Row = {
  source_file_id?: string;
  id?: string;
  drive_file_id: string;
  file_name: string;
  mime_type?: string | null;
  file_size_bytes?: number | null;
  ocr_status?: string | null;
  created_at?: string | null;
  matched_article_title?: string | null;
  matched_text_preview?: string | null;
};

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function japaneseError(message: string) {
  const text = message.trim();
  if (!text) return '処理に失敗しました。';
  if (/missing or null origin/i.test(text)) return '認証情報の確認に失敗しました。ページを再読み込みしてください。';
  if (/origin header is required/i.test(text)) return '認証情報の確認に失敗しました。ページを再読み込みしてください。';
  if (/google oauth/i.test(text)) return 'Googleドライブへの接続に失敗しました。';
  if (/google drive list failed/i.test(text)) return 'Googleドライブの資料一覧を取得できませんでした。';
  if (/credentials are not configured/i.test(text)) return 'Googleドライブの接続設定が完了していません。';
  if (/neon/i.test(text) && /(failed|error)/i.test(text)) return 'データベースへの登録または検索に失敗しました。';
  if (/http\s*4\d\d/i.test(text)) return '入力内容または認証状態を確認してください。';
  if (/http\s*5\d\d/i.test(text)) return 'サーバー側の処理に失敗しました。時間をおいて再度実行してください。';
  return text;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(japaneseError(String(json.error || `HTTP ${res.status}`)));
  return json;
}

function ocrLabel(status?: string | null) {
  if (status === 'done') return 'OCR済み';
  if (status === 'processing') return 'OCR処理中';
  if (status === 'failed') return 'OCR失敗';
  return '未OCR';
}

function canOcr(row: Row) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(String(row.mime_type || '').toLowerCase());
}

export function DriveNeonSimpleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('接続を確認しています…');
  const [syncing, setSyncing] = useState(false);
  const [ocrRunningId, setOcrRunningId] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);

  async function loadRows(q = '') {
    const res = await fetch(`/api/cloud-stock/files?q=${encodeURIComponent(q.trim())}`, {
      headers: { 'x-app-password': appPassword }
    });
    const json = await readJson(res);
    const next = Array.isArray(json.rows) ? json.rows : [];
    setRows(next);
    return next;
  }

  useEffect(() => {
    if (!appPassword) return;
    void (async () => {
      try {
        // This is a single-user vault. Always establish the deterministic owner
        // session so stale/manual Neon sessions cannot split data by user_id.
        const auth = await fetch('/api/cloud-stock/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
          body: JSON.stringify({ action: 'auto' })
        });
        await readJson(auth);
        const initial = await loadRows('');
        setReady(true);
        setMessage(`登録済み資料：${initial.length}件`);
      } catch (error) {
        setReady(false);
        setMessage(japaneseError(error instanceof Error ? error.message : '接続に失敗しました。'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  async function syncDrive() {
    if (!ready || syncing) return;
    setSyncing(true);
    setMessage('Googleドライブの資料を確認しています…');
    try {
      const res = await fetch('/api/cloud-stock/sync-drive', {
        method: 'POST',
        headers: { 'x-app-password': appPassword }
      });
      const json = await readJson(res);
      const current = await loadRows(query);
      setMessage(`同期完了：新規登録 ${Number(json.newly_registered || 0)}件／ドライブ内 ${Number(json.drive_files || 0)}件／現在表示 ${current.length}件`);
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : '同期に失敗しました。'));
    } finally {
      setSyncing(false);
    }
  }

  async function runOcr(row: Row) {
    const sourceFileId = row.source_file_id || row.id || '';
    if (!sourceFileId || ocrRunningId) return;
    setOcrRunningId(sourceFileId);
    setMessage(`「${row.file_name}」をOCRしています…`);
    try {
      const res = await fetch('/api/cloud-stock/ocr', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
        body: JSON.stringify({ source_file_id: sourceFileId })
      });
      const json = await readJson(res);
      await loadRows(query);
      setMessage(`OCR完了：「${row.file_name}」 ${Number(json.ocr_char_count || 0).toLocaleString()}文字。OCR本文を検索できます。`);
    } catch (error) {
      await loadRows(query).catch(() => []);
      setMessage(japaneseError(error instanceof Error ? error.message : 'OCRに失敗しました。'));
    } finally {
      setOcrRunningId('');
    }
  }

  async function search() {
    try {
      const current = await loadRows(query);
      setMessage(`検索結果：${current.length}件`);
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : '検索に失敗しました。'));
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm font-bold text-emerald-700">資料を追加</p>
        <h1 className="mt-1 text-xl font-black">Googleドライブに保存して、MJに登録</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          原本はGoogleドライブの「01 Originals」に保存します。資料を追加した後、この画面に戻って「MJに同期する」を押してください。
        </p>
        <div className="mt-4 grid gap-3">
          <a className="btn btn-primary flex min-h-12 items-center justify-center text-center" href={DRIVE_URL} target="_blank" rel="noreferrer">
            1. Googleドライブを開いて資料を追加
          </a>
          <button className="btn min-h-12" type="button" onClick={syncDrive} disabled={!ready || syncing}>
            {syncing ? '同期しています…' : '2. 追加した資料をMJに同期する'}
          </button>
        </div>
        <p className="mt-3 text-sm font-semibold text-zinc-700">{message}</p>
      </div>

      <div className="card p-5">
        <p className="text-sm font-bold text-zinc-500">資料一覧・検索</p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">画像は一覧からOCRできます。OCR済みの本文もこの検索欄から探せます。</p>
        <div className="mt-3 flex gap-2">
          <input
            className="input min-w-0 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            placeholder="ファイル名・OCR本文を検索"
          />
          <button className="btn shrink-0" type="button" onClick={search} disabled={!ready}>検索</button>
        </div>

        <div className="mt-4 space-y-2">
          {rows.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
              まだ登録された資料はありません。
            </div>
          ) : rows.map((row) => {
            const sourceFileId = row.source_file_id || row.id || '';
            const running = ocrRunningId === sourceFileId;
            return (
              <div key={sourceFileId || row.drive_file_id} className="rounded-xl border border-zinc-200 p-3">
                <a
                  href={`https://drive.google.com/file/d/${encodeURIComponent(row.drive_file_id)}/view`}
                  target="_blank"
                  rel="noreferrer"
                  className="block hover:opacity-70"
                >
                  <div className="break-words text-sm font-bold text-zinc-900">{row.file_name}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {[formatBytes(row.file_size_bytes), ocrLabel(row.ocr_status)].filter(Boolean).join(' · ')}
                  </div>
                </a>

                {row.matched_text_preview && (
                  <p className="mt-2 line-clamp-4 rounded-lg bg-zinc-50 p-2 text-xs leading-5 text-zinc-600">{row.matched_text_preview}</p>
                )}

                <div className="mt-3 flex gap-2">
                  {canOcr(row) ? (
                    <button
                      className="btn min-h-10 flex-1"
                      type="button"
                      disabled={!ready || Boolean(ocrRunningId) || row.ocr_status === 'done'}
                      onClick={() => void runOcr(row)}
                    >
                      {running ? 'OCRしています…' : row.ocr_status === 'done' ? 'OCR済み' : row.ocr_status === 'failed' ? 'OCRを再実行' : 'OCRする'}
                    </button>
                  ) : (
                    <div className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 text-center text-xs text-zinc-500">PDFのOCRは未対応</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
