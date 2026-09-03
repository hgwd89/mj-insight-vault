'use client';

import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DRIVE_URL = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';

type Row = {
  source_file_id?: string;
  id?: string;
  drive_file_id: string;
  file_name: string;
  file_size_bytes?: number | null;
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

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`));
  return json;
}

export function DriveNeonSimpleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('接続中…');
  const [syncing, setSyncing] = useState(false);
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
        let auth = await fetch('/api/cloud-stock/auth', {
          headers: { 'x-app-password': appPassword }
        });
        if (!auth.ok) {
          auth = await fetch('/api/cloud-stock/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
            body: JSON.stringify({ action: 'auto' })
          });
        }
        await readJson(auth);
        const initial = await loadRows('');
        setReady(true);
        setMessage(`登録済み ${initial.length}件`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '接続に失敗しました。');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  async function syncDrive() {
    if (!ready || syncing) return;
    setSyncing(true);
    setMessage('Google Driveを確認中…');
    try {
      const res = await fetch('/api/cloud-stock/sync-drive', {
        method: 'POST',
        headers: { 'x-app-password': appPassword }
      });
      const json = await readJson(res);
      const current = await loadRows(query);
      setMessage(`同期完了：新規 ${Number(json.newly_registered || 0)}件 / Drive ${Number(json.drive_files || 0)}件 / 表示 ${current.length}件`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同期に失敗しました。');
    } finally {
      setSyncing(false);
    }
  }

  async function search() {
    try {
      const current = await loadRows(query);
      setMessage(`${current.length}件`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '検索に失敗しました。');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm font-bold text-emerald-700">資料追加</p>
        <h1 className="mt-1 text-xl font-black">Google Driveへ追加 → MJに同期</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          原本はGoogle Driveに保存します。Driveで追加した後、この画面に戻って「同期する」を押すとNeonへ検索用情報を登録します。
        </p>
        <div className="mt-4 grid gap-3">
          <a className="btn btn-primary flex min-h-12 items-center justify-center text-center" href={DRIVE_URL} target="_blank" rel="noreferrer">
            1. Google Driveを開いて資料を追加
          </a>
          <button className="btn min-h-12" type="button" onClick={syncDrive} disabled={!ready || syncing}>
            {syncing ? '同期中…' : '2. Driveの資料をMJに同期する'}
          </button>
        </div>
        <p className="mt-3 text-sm font-semibold text-zinc-700">{message}</p>
      </div>

      <div className="card p-5">
        <p className="text-sm font-bold text-zinc-500">資料一覧・検索</p>
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
          ) : rows.map((row) => (
            <a
              key={row.source_file_id || row.id || row.drive_file_id}
              href={`https://drive.google.com/file/d/${encodeURIComponent(row.drive_file_id)}/view`}
              target="_blank"
              rel="noreferrer"
              className="block rounded-xl border border-zinc-200 p-3 hover:border-zinc-400"
            >
              <div className="break-words text-sm font-bold text-zinc-900">{row.file_name}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {[formatBytes(row.file_size_bytes), row.matched_article_title || ''].filter(Boolean).join(' · ')}
              </div>
              {row.matched_text_preview && (
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-zinc-600">{row.matched_text_preview}</p>
              )}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
