'use client';

import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

type TableStatus = {
  source_table: string;
  archived_count: number;
  verified_count: number;
};

type TableProgress = {
  table: string;
  status: '待機' | '処理中' | '完了' | '失敗';
  archived: number;
  error?: string;
};

async function jsonOrError(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`));
  return json;
}

export function LegacySupabaseDbArchive() {
  const appPassword = useAppPassword();
  const [tables, setTables] = useState<string[]>([]);
  const [status, setStatus] = useState<TableStatus[]>([]);
  const [progress, setProgress] = useState<TableProgress[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function ensureNeonSession() {
    const current = await fetch('/api/cloud-stock/auth', { headers: { 'x-app-password': appPassword } });
    if (current.ok) return;
    const bootstrap = await fetch('/api/cloud-stock/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
      body: JSON.stringify({ action: 'auto' })
    });
    await jsonOrError(bootstrap);
  }

  async function loadStatus() {
    await ensureNeonSession();
    const res = await fetch('/api/cloud-stock/import-supabase-db', {
      headers: { 'x-app-password': appPassword }
    });
    const json = await jsonOrError(res);
    const essential = Array.isArray(json.essential_tables) ? json.essential_tables.map(String) : [];
    const rows = Array.isArray(json.status) ? json.status as TableStatus[] : [];
    setTables(essential);
    setStatus(rows);
    if (!progress.length) {
      setProgress(essential.map((table) => ({ table, status: '待機', archived: 0 })));
    }
    setMessage(`Neon退避済み ${rows.reduce((sum, row) => sum + Number(row.archived_count || 0), 0)}行。Supabase削除releaseは未許可です。`);
    return essential;
  }

  function patchProgress(table: string, patch: Partial<TableProgress>) {
    setProgress((current) => {
      const exists = current.some((row) => row.table === table);
      if (!exists) return [...current, { table, status: '待機', archived: 0, ...patch }];
      return current.map((row) => row.table === table ? { ...row, ...patch } : row);
    });
  }

  async function archiveAll() {
    if (busy) return;
    setBusy(true);
    setMessage('必須DBデータの退避を開始します。Supabase側は読み取りのみです。');

    try {
      const essential = tables.length ? tables : await loadStatus();
      for (const table of essential) {
        patchProgress(table, { status: '処理中', archived: 0, error: undefined });
        let offset = 0;
        let archived = 0;
        let pages = 0;
        try {
          while (pages < 20_000) {
            const res = await fetch('/api/cloud-stock/import-supabase-db', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
              body: JSON.stringify({ table, offset, limit: 25 })
            });
            const json = await jsonOrError(res);
            archived += Number(json.archived || 0);
            offset = Number(json.next_offset || offset);
            pages += 1;
            patchProgress(table, { status: '処理中', archived });
            setMessage(`${table}: ${archived}行をNeonへ退避済み…`);
            if (json.has_more !== true) break;
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          patchProgress(table, { status: '完了', archived });
        } catch (error) {
          patchProgress(table, {
            status: '失敗',
            archived,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      await loadStatus().catch(() => null);
      setMessage('必須DB退避処理が終了しました。失敗テーブルはSupabase復旧後に再実行できます。原本・DBともSupabase側はまだ削除していません。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-lg font-black">Report・検索・Inventory用DBデータをNeonへ退避</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        Supabaseが読める時だけ、最終利用に必要な旧DB行をJSON + SHA-256でNeonへ保存します。Supabaseへの書き込み・削除、OCR、分類、Report実行はしません。
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn" type="button" disabled={busy} onClick={() => loadStatus().catch((error) => setMessage(`確認失敗：${error instanceof Error ? error.message : String(error)}`))}>
          退避状況を確認
        </button>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={archiveAll}>
          {busy ? '必須DBデータを退避中…' : '必須DBデータをNeonへ退避'}
        </button>
      </div>
      <p className="mt-3 text-sm text-zinc-700">{message || '退避先Neonは準備済みです。'}</p>

      {status.length > 0 && (
        <div className="mt-4 grid gap-2 text-sm md:grid-cols-2">
          {status.map((row) => (
            <div key={row.source_table} className="rounded-xl bg-zinc-50 p-3">
              <b>{row.source_table}</b><br />
              {Number(row.archived_count || 0)}行 / 検証済み {Number(row.verified_count || 0)}行
            </div>
          ))}
        </div>
      )}

      {progress.length > 0 && (
        <div className="mt-4 max-h-96 overflow-auto rounded-xl border border-zinc-200 p-3 text-sm">
          {progress.map((row) => (
            <div key={row.table} className="border-b border-zinc-200 py-2 last:border-0">
              <b>{row.table}</b> <span className="badge ml-2">{row.status}</span>
              <span className="ml-2 text-xs text-zinc-500">{row.archived}行</span>
              {row.error && <p className="mt-1 text-xs text-red-700">{row.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
