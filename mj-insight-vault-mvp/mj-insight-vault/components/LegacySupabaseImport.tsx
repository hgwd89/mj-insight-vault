'use client';

import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

type LegacyObject = {
  path: string;
  size: number | null;
  mime_type: string | null;
  updated_at: string | null;
};

type CopyResult = {
  ok: boolean;
  reused?: boolean;
  content_verified?: boolean;
  source_path: string;
  source_bucket?: string;
  source_sha256?: string;
  drive_sha256?: string;
  original_file_name?: string;
  mime_type?: string;
  file_size_bytes?: number;
  drive_file_id?: string;
  drive_folder_id?: string;
  web_view_link?: string | null;
  error?: string;
};

type RescueStatus = {
  copied: number;
  verified: number;
  deleted: number;
  retained_in_supabase: number;
  copied_bytes: number;
  deletion_released: boolean;
};

function formatBytes(bytes: number | null | undefined) {
  const value = Number(bytes || 0);
  if (!value) return '-';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function jsonOrError(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`));
  return json;
}

export function LegacySupabaseImport() {
  const appPassword = useAppPassword();
  const [objects, setObjects] = useState<LegacyObject[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(0);
  const [failed, setFailed] = useState<Array<{ path: string; error: string }>>([]);
  const [rescueStatus, setRescueStatus] = useState<RescueStatus | null>(null);
  const totalBytes = objects.reduce((sum, item) => sum + (item.size || 0), 0);

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

  async function loadRescueStatus() {
    await ensureNeonSession();
    const res = await fetch('/api/cloud-stock/legacy-status', {
      headers: { 'x-app-password': appPassword }
    });
    const json = await jsonOrError(res);
    setRescueStatus({
      copied: Number(json.copied || 0),
      verified: Number(json.verified || 0),
      deleted: Number(json.deleted || 0),
      retained_in_supabase: Number(json.retained_in_supabase || 0),
      copied_bytes: Number(json.copied_bytes || 0),
      deletion_released: json.deletion_released === true
    });
  }

  async function scan() {
    if (busy) return;
    setBusy(true);
    setMessage('Supabase Storageの保存済み原本を確認中…');
    try {
      const res = await fetch('/api/cloud-stock/import-supabase', {
        headers: { 'x-app-password': appPassword }
      });
      const json = await jsonOrError(res);
      const rows = Array.isArray(json.objects) ? json.objects as LegacyObject[] : [];
      setObjects(rows);
      setMessage(`${rows.length}件を検出しました。既知容量 ${formatBytes(json.total_bytes_known)}。Supabase側は削除しません。`);
      await loadRescueStatus().catch(() => null);
    } catch (error) {
      setObjects([]);
      setMessage(`確認失敗：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function registerNeon(row: CopyResult) {
    if (!row.drive_file_id || !row.original_file_name || !row.source_bucket || !row.source_sha256 || row.content_verified !== true) {
      throw new Error('Drive copy receipt is incomplete or not hash-verified.');
    }
    if (row.drive_sha256 !== row.source_sha256) {
      throw new Error('Drive copy SHA-256 does not match Supabase source.');
    }
    const res = await fetch('/api/cloud-stock/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
      body: JSON.stringify({
        drive_file_id: row.drive_file_id,
        drive_folder_id: row.drive_folder_id,
        file_name: row.original_file_name,
        mime_type: row.mime_type,
        file_size_bytes: row.file_size_bytes,
        memo: `legacy_supabase_path:${row.source_path}`,
        legacy_source_provider: 'supabase_storage',
        legacy_source_bucket: row.source_bucket,
        legacy_source_path: row.source_path,
        legacy_source_sha256: row.source_sha256,
        legacy_copy_verified: true
      })
    });
    await jsonOrError(res);
  }

  async function migrateAll() {
    if (!objects.length || busy) return;
    setBusy(true);
    setCopied(0);
    setFailed([]);
    setMessage('Neonセッションを確認中…');

    try {
      await ensureNeonSession();
      let successCount = 0;
      const failures: Array<{ path: string; error: string }> = [];

      for (let i = 0; i < objects.length; i += 2) {
        const batch = objects.slice(i, i + 2);
        setMessage(`Google Driveへ複製・SHA-256検証中 ${i + 1}〜${Math.min(i + batch.length, objects.length)} / ${objects.length}…`);

        try {
          const res = await fetch('/api/cloud-stock/import-supabase', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
            body: JSON.stringify({ paths: batch.map((item) => item.path) })
          });
          const json = await jsonOrError(res);
          const results = Array.isArray(json.results) ? json.results as CopyResult[] : [];

          for (const result of results) {
            if (!result.ok || result.content_verified !== true) {
              failures.push({ path: result.source_path, error: result.error || 'Drive copy verification failed' });
              continue;
            }
            try {
              await registerNeon(result);
              successCount += 1;
              setCopied(successCount);
            } catch (error) {
              failures.push({
                path: result.source_path,
                error: `Drive保存・ハッシュ検証済み / Neon登録失敗: ${error instanceof Error ? error.message : String(error)}`
              });
            }
          }
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error);
          for (const item of batch) failures.push({ path: item.path, error: note });
        }
      }

      setFailed(failures);
      await loadRescueStatus().catch(() => null);
      setMessage(`完了：Drive + SHA-256検証 + Neon ${successCount}件 / 要確認 ${failures.length}件。Supabase原本はそのまま残しています。`);
    } catch (error) {
      setMessage(`移行停止：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h1 className="text-xl font-black">Supabase → Google Drive 移行</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          旧Supabase Storageの原本をGoogle Drive「01 Originals」へ複製し、SHA-256で内容一致を検証してからNeon検索DBへ登録します。
          Supabase側のデータは削除しません。OCR・分類・Reportも起動しません。
        </p>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" disabled={busy} onClick={scan}>保存済み原本を確認</button>
          <button className="btn btn-primary" type="button" disabled={busy || !objects.length} onClick={migrateAll}>
            {busy ? '処理中…' : `${objects.length}件をDrive + Neonへ複製`}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => loadRescueStatus().catch((error) => setMessage(`Neon確認失敗：${error instanceof Error ? error.message : String(error)}`))}>
            Neon退避状況を確認
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-700">{message || 'まず「保存済み原本を確認」を押してください。'}</p>
        {objects.length > 0 && (
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
            <div className="rounded-xl bg-zinc-50 p-3"><b>{objects.length}</b><br />Supabase Storage原本</div>
            <div className="rounded-xl bg-zinc-50 p-3"><b>{formatBytes(totalBytes)}</b><br />既知容量</div>
            <div className="rounded-xl bg-zinc-50 p-3"><b>{copied}</b><br />今回のDrive + SHA検証 + Neon完了</div>
          </div>
        )}
      </div>

      {rescueStatus && (
        <div className="card p-5">
          <h2 className="font-bold">永続退避ステータス</h2>
          <div className="mt-3 grid gap-3 text-sm md:grid-cols-4">
            <div className="rounded-xl bg-zinc-50 p-3"><b>{rescueStatus.copied}</b><br />Neon登録済み</div>
            <div className="rounded-xl bg-zinc-50 p-3"><b>{rescueStatus.verified}</b><br />SHA検証済み</div>
            <div className="rounded-xl bg-zinc-50 p-3"><b>{formatBytes(rescueStatus.copied_bytes)}</b><br />退避済み容量</div>
            <div className="rounded-xl bg-zinc-50 p-3"><b>{rescueStatus.deleted}</b><br />Supabase削除済み</div>
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-600">
            削除release: {rescueStatus.deletion_released ? '許可済み' : '未許可'}。現在はSupabase削除を実行しません。
          </p>
        </div>
      )}

      {failed.length > 0 && (
        <div className="card p-5">
          <h2 className="font-bold">要確認 {failed.length}件</h2>
          <div className="mt-3 max-h-80 overflow-auto text-sm">
            {failed.map((item, index) => (
              <div className="border-b border-zinc-200 py-2 last:border-0" key={`${item.path}-${index}`}>
                <b className="break-all">{item.path}</b>
                <p className="mt-1 text-xs text-zinc-600">{item.error}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
