'use client';

import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

type Counts = {
  batches?: number;
  source_images?: number;
  articles?: number;
  article_embeddings?: number;
  chat_reports?: number;
  storage_files?: number;
};

type Preview = {
  confirm_text?: string;
  counts?: Counts;
  note?: string;
};

type DeleteResult = {
  ok?: boolean;
  before?: Counts;
  after?: Counts;
  deleted?: Record<string, number>;
  storage_errors?: string[];
};

const DEFAULT_CONFIRM = 'DELETE_REUPLOAD_DATA';

function countValue(counts: Counts | undefined, key: keyof Counts) {
  return Number(counts?.[key] || 0);
}

function CountBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white p-3 text-sm">
      <b>{value}</b><br />
      <span className="text-zinc-600">{label}</span>
    </div>
  );
}

export function UploadDataResetPanel() {
  const password = useAppPassword();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [includeReports, setIncludeReports] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<DeleteResult | null>(null);

  const expected = preview?.confirm_text || DEFAULT_CONFIRM;
  const counts = preview?.counts || {};

  async function loadPreview() {
    setBusy(true);
    setMessage('');
    setResult(null);

    try {
      const res = await fetch('/api/admin/clear-uploads', {
        method: 'GET',
        headers: { 'x-app-password': password }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '削除対象の確認に失敗しました');
      setPreview(json);
      setOpen(true);
      setMessage('削除対象を読み込みました。件数を確認してください。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '削除対象の確認に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    if (confirmText !== expected) {
      setMessage(`確認文字列「${expected}」を正確に入力してください。`);
      return;
    }

    const ok = window.confirm('古いアップロード画像・記事・embeddingを削除します。元に戻せません。OCR高画質設定で元画像を入れ直す前提で実行しますか？');
    if (!ok) return;

    setBusy(true);
    setMessage('削除中です。画面を閉じないでください。');
    setResult(null);

    try {
      const res = await fetch('/api/admin/clear-uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ confirm: confirmText, include_reports: includeReports })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '一括削除に失敗しました');

      setResult(json);
      setPreview({ confirm_text: expected, counts: json.after || {} });
      setConfirmText('');
      setMessage('削除完了。元画像をこの画面から再アップロードしてください。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '一括削除に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card border-amber-200 bg-amber-50 p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="font-bold text-amber-950">OCR高画質で入れ直す</h2>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            以前の低めの画像品質で作られた記事データを消して、元画像から再アップロードするための操作です。
          </p>
        </div>
        <button className="btn" type="button" onClick={loadPreview} disabled={busy}>
          {busy ? '確認中' : '削除対象を確認'}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 md:grid-cols-6">
            <CountBox label="アップロード履歴" value={countValue(counts, 'batches')} />
            <CountBox label="画像" value={countValue(counts, 'source_images')} />
            <CountBox label="記事" value={countValue(counts, 'articles')} />
            <CountBox label="embedding" value={countValue(counts, 'article_embeddings')} />
            <CountBox label="分析レポート" value={countValue(counts, 'chat_reports')} />
            <CountBox label="Storage画像" value={countValue(counts, 'storage_files')} />
          </div>

          <div className="rounded-2xl border border-red-200 bg-white p-4">
            <h3 className="font-bold text-red-700">一括削除の実行</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-700">
              実行すると、アップロード画像・記事・embedding・Storage画像を削除します。分析レポート履歴も基本的には削除してください。古いOCR結果が混ざるのを防ぐためです。
            </p>
            <p className="mt-3 rounded-xl bg-zinc-50 p-3 font-mono text-sm">{expected}</p>
            <input
              className="input mt-3"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="確認文字列を入力"
              disabled={busy}
            />
            <label className="mt-3 flex gap-3 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
              <input type="checkbox" checked={includeReports} onChange={(e) => setIncludeReports(e.target.checked)} disabled={busy} />
              分析レポート履歴も削除する
            </label>
            <button
              className="btn mt-4 border-red-300 text-red-700 hover:bg-red-50"
              type="button"
              onClick={deleteAll}
              disabled={busy || confirmText !== expected}
            >
              {busy ? '処理中' : '古いアップロードデータを一括削除'}
            </button>
          </div>
        </div>
      )}

      {message && <p className="mt-3 text-sm leading-6 text-zinc-700">{message}</p>}
      {result?.deleted && (
        <div className="mt-4 rounded-2xl bg-white p-4 text-sm leading-6 text-zinc-700">
          <h3 className="font-bold">削除結果</h3>
          <pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify(result.deleted, null, 2)}</pre>
          {result.storage_errors && result.storage_errors.length > 0 && (
            <p className="mt-2 text-amber-800">Storage削除エラー: {result.storage_errors.join(' / ')}</p>
          )}
        </div>
      )}
    </div>
  );
}
