'use client';

import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DRIVE_URL = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';
const OCR_CONCURRENCY = 3;

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

type BulkProgress = {
  completed: number;
  total: number;
  failed: number;
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

function sourceId(row: Row) {
  return row.source_file_id || row.id || '';
}

export function DriveNeonSimpleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('接続を確認しています…');
  const [syncing, setSyncing] = useState(false);
  const [bulkOcrRunning, setBulkOcrRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>({ completed: 0, total: 0, failed: 0 });
  const [pendingOcrCount, setPendingOcrCount] = useState(0);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);

  async function loadRows(q = '') {
    const res = await fetch(`/api/cloud-stock/files?q=${encodeURIComponent(q.trim())}`, {
      headers: { 'x-app-password': appPassword }
    });
    const json = await readJson(res);
    const next = Array.isArray(json.rows) ? json.rows as Row[] : [];
    setRows(next);
    return next;
  }

  async function loadPendingOcr() {
    const res = await fetch('/api/cloud-stock/files?mode=pending_ocr', {
      headers: { 'x-app-password': appPassword }
    });
    const json = await readJson(res);
    const next = Array.isArray(json.rows) ? json.rows as Row[] : [];
    const total = Number.isFinite(Number(json.total)) ? Math.max(0, Number(json.total)) : next.length;
    setPendingOcrCount(total);
    return { rows: next, total };
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
        const [initial, pending] = await Promise.all([loadRows(''), loadPendingOcr()]);
        setReady(true);
        setMessage(`登録済み資料：${initial.length}件／未OCR画像：${pending.total}件`);
      } catch (error) {
        setReady(false);
        setMessage(japaneseError(error instanceof Error ? error.message : '接続に失敗しました。'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  async function syncDrive() {
    if (!ready || syncing || bulkOcrRunning) return;
    setSyncing(true);
    setMessage('Googleドライブの資料を確認しています…');
    try {
      const res = await fetch('/api/cloud-stock/sync-drive', {
        method: 'POST',
        headers: { 'x-app-password': appPassword }
      });
      const json = await readJson(res);
      const [current, pending] = await Promise.all([loadRows(query), loadPendingOcr()]);
      setMessage(`同期完了：新規登録 ${Number(json.newly_registered || 0)}件／ドライブ内 ${Number(json.drive_files || 0)}件／未OCR画像 ${pending.total}件／現在表示 ${current.length}件`);
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : '同期に失敗しました。'));
    } finally {
      setSyncing(false);
    }
  }

  async function runBulkOcr() {
    if (!ready || syncing || bulkOcrRunning) return;

    setBulkOcrRunning(true);
    setBulkProgress({ completed: 0, total: 0, failed: 0 });

    const attempted = new Set<string>();
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    let initialTotal = 0;

    try {
      let queue = await loadPendingOcr();
      initialTotal = queue.total;
      setBulkProgress({ completed: 0, total: initialTotal, failed: 0 });

      if (initialTotal === 0) {
        setMessage('一括OCR対象はありません。');
        return;
      }

      setMessage(`一括OCRを開始します：0/${initialTotal}件`);

      while (true) {
        const candidates = queue.rows.filter((row) => {
          const id = sourceId(row);
          return Boolean(id) && !attempted.has(id);
        });

        if (candidates.length === 0) break;

        for (let index = 0; index < candidates.length; index += OCR_CONCURRENCY) {
          const chunk = candidates.slice(index, index + OCR_CONCURRENCY);
          const results = await Promise.all(chunk.map(async (row) => {
            const id = sourceId(row);
            attempted.add(id);
            try {
              const res = await fetch('/api/cloud-stock/ocr', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
                body: JSON.stringify({ source_file_id: id })
              });
              await readJson(res);
              return true;
            } catch {
              return false;
            }
          }));

          for (const ok of results) {
            completed += 1;
            if (ok) succeeded += 1;
            else failed += 1;
          }

          setBulkProgress({ completed, total: initialTotal, failed });
          setMessage(`一括OCR中：${completed}/${initialTotal}件（成功 ${succeeded}／失敗 ${failed}）`);
        }

        queue = await loadPendingOcr();
        const hasUnattempted = queue.rows.some((row) => {
          const id = sourceId(row);
          return Boolean(id) && !attempted.has(id);
        });
        if (!hasUnattempted) break;
      }

      const [current, remaining] = await Promise.all([loadRows(query), loadPendingOcr()]);
      setMessage(
        `一括OCR完了：成功 ${succeeded}件／失敗 ${failed}件／対象 ${completed}件` +
        (remaining.total > 0 ? `／再試行対象 ${remaining.total}件` : '') +
        `／現在表示 ${current.length}件`
      );
    } catch (error) {
      await Promise.all([loadRows(query).catch(() => []), loadPendingOcr().catch(() => ({ rows: [], total: pendingOcrCount }))]);
      setMessage(japaneseError(error instanceof Error ? error.message : '一括OCRに失敗しました。'));
    } finally {
      setBulkOcrRunning(false);
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
          原本はGoogleドライブの「01 Originals」に保存します。資料を追加した後、この画面に戻って同期し、未OCR画像をまとめて処理します。
        </p>
        <div className="mt-4 grid gap-3">
          <a className="btn btn-primary flex min-h-12 items-center justify-center text-center" href={DRIVE_URL} target="_blank" rel="noreferrer">
            1. Googleドライブを開いて資料を追加
          </a>
          <button className="btn min-h-12" type="button" onClick={syncDrive} disabled={!ready || syncing || bulkOcrRunning}>
            {syncing ? '同期しています…' : '2. 追加した資料をMJに同期する'}
          </button>
          <button
            className="btn min-h-12"
            type="button"
            onClick={() => void runBulkOcr()}
            disabled={!ready || syncing || bulkOcrRunning || pendingOcrCount === 0}
          >
            {bulkOcrRunning
              ? `OCR中 ${bulkProgress.completed}/${bulkProgress.total}件`
              : pendingOcrCount > 0
                ? `3. 未OCR画像を一括OCR（${pendingOcrCount}件）`
                : '3. OCR対象なし'}
          </button>
        </div>
        {bulkOcrRunning && bulkProgress.total > 0 && (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200">
            <div
              className="h-full bg-zinc-800 transition-all"
              style={{ width: `${Math.min(100, Math.round((bulkProgress.completed / bulkProgress.total) * 100))}%` }}
            />
          </div>
        )}
        <p className="mt-3 text-sm font-semibold text-zinc-700">{message}</p>
      </div>

      <div className="card p-5">
        <p className="text-sm font-bold text-zinc-500">資料一覧・検索</p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">OCRは上の「未OCR画像を一括OCR」でまとめて実行します。OCR済み本文もこの検索欄から探せます。</p>
        <div className="mt-3 flex gap-2">
          <input
            className="input min-w-0 flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            placeholder="ファイル名・OCR本文を検索"
          />
          <button className="btn shrink-0" type="button" onClick={search} disabled={!ready || bulkOcrRunning}>検索</button>
        </div>

        <div className="mt-4 space-y-2">
          {rows.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
              まだ登録された資料はありません。
            </div>
          ) : rows.map((row) => {
            const id = sourceId(row);
            return (
              <div key={id || row.drive_file_id} className="rounded-xl border border-zinc-200 p-3">
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

                {!canOcr(row) && (
                  <div className="mt-2 rounded-lg bg-zinc-100 px-3 py-2 text-center text-xs text-zinc-500">PDFのOCRは未対応</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
