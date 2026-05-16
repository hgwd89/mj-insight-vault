'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const MAX_FILES = 20;
const MAX_FILE_MB = 4;

type UploadSummary = {
  batch_id: string;
  image_count: number;
  success_image_count: number;
  failed_image_count: number;
  article_count: number;
  date_unknown_count: number;
  queued_image_count?: number;
  mode?: string;
};

export function UploadForm() {
  const password = useAppPassword();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [articleDate, setArticleDate] = useState('');
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const heicFiles = useMemo(() => files.filter((f) => /heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name)), [files]);
  const oversizedFiles = useMemo(() => files.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024), [files]);

  function selectFiles(nextFiles: File[]) {
    setSummary(null);

    if (nextFiles.length > MAX_FILES) {
      setStatus(`最大${MAX_FILES}枚までです。${MAX_FILES}枚に絞りました。不要な画像を削除して再実行してください。`);
    } else {
      setStatus('');
    }

    setFiles(nextFiles.slice(0, MAX_FILES));
  }

  function removeFile(index: number) {
    setSummary(null);
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function clearFiles() {
    setFiles([]);
    setSummary(null);
    setStatus('選択画像をクリアしました。');
  }

  async function upload() {
    if (files.length > MAX_FILES) {
      setStatus(`最大${MAX_FILES}枚までに減らしてください。`);
      return;
    }

    if (heicFiles.length > 0) {
      setStatus('HEIC/HEIFはこのアプリでは非対応です。JPGまたはPNGに変換してからアップロードしてください。');
      return;
    }

    if (oversizedFiles.length > 0) {
      setStatus(`${MAX_FILE_MB}MBを超える画像があります。画像を削除または圧縮してください。`);
      return;
    }

    setBusy(true);
    setSummary(null);
    setStatus('画像を保存しています。OCRはアップロード詳細画面で順番に処理します。');

    try {
      const form = new FormData();
      form.set('memo', memo);
      form.set('article_date', articleDate.trim());
      files.forEach((file) => form.append('files', file));

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-app-password': password },
        body: form
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');

      const nextSummary: UploadSummary = json.summary || {
        batch_id: json.batch.id,
        image_count: json.images?.length || files.length,
        success_image_count: 0,
        failed_image_count: 0,
        article_count: 0,
        date_unknown_count: 0,
        queued_image_count: json.images?.length || files.length,
        mode: 'queued'
      };

      setSummary(nextSummary);
      setStatus('画像保存が完了しました。アップロード詳細で「未処理画像を順番にOCR」を押してください。');
      setFiles([]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'エラーが発生しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h1 className="text-xl font-black">MJ画像アップロード</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        最大{MAX_FILES}枚。画像は1枚あたり{MAX_FILE_MB}MB以下。まず画像だけ保存し、OCRは詳細画面で順番に処理します。
      </p>

      <div className="mt-5 space-y-4">
        <textarea
          className="input min-h-20"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="メモ：2026年5月前半 / 食品・化粧品多め など"
        />

        <input
          className="input"
          value={articleDate}
          onChange={(e) => setArticleDate(e.target.value)}
          placeholder="記事日付：例 2026-05-13 / 5月13日 / 2026年5月13日"
          disabled={busy}
        />

        <input
          className="input"
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          onChange={(e) => selectFiles(Array.from(e.target.files || []))}
          disabled={busy}
        />

        {heicFiles.length > 0 && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-700">
            HEIC/HEIFが含まれています。このアプリでは非対応です。JPGまたはPNGに変換してください。
          </div>
        )}

        {oversizedFiles.length > 0 && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-700">
            {MAX_FILE_MB}MBを超える画像が{oversizedFiles.length}枚あります。アップロード失敗の原因になるため、削除または圧縮してください。
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600">
          <span>選択中：{files.length}/{MAX_FILES}枚</span>
          {files.length > 0 && <button className="btn" type="button" onClick={clearFiles} disabled={busy}>全てクリア</button>}
        </div>

        {files.length > 0 && (
          <ul className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
            {files.map((file, index) => {
              const sizeMb = file.size / 1024 / 1024;
              const tooLarge = sizeMb > MAX_FILE_MB;

              return (
                <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 border-b border-zinc-200 py-2 last:border-b-0">
                  <span className={tooLarge ? 'text-red-600' : ''}>{index + 1}. {file.name} / {sizeMb.toFixed(1)}MB</span>
                  <button className="btn shrink-0" type="button" onClick={() => removeFile(index)} disabled={busy}>削除</button>
                </li>
              );
            })}
          </ul>
        )}

        <button className="btn btn-primary" onClick={upload} disabled={!files.length || busy || oversizedFiles.length > 0 || heicFiles.length > 0}>
          {busy ? '保存中' : '画像を保存して処理待ちにする'}
        </button>

        {status && <p className="text-sm leading-6 text-zinc-700">{status}</p>}

        {summary && (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <h2 className="font-bold">アップロード保存サマリー</h2>
            <div className="mt-3 grid gap-2 text-sm md:grid-cols-5">
              <div className="rounded-xl bg-white p-3"><b>{summary.image_count}</b><br />画像</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.queued_image_count ?? summary.image_count}</b><br />処理待ち</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.success_image_count}</b><br />成功</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.failed_image_count}</b><br />失敗</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.article_count}</b><br />記事候補</div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link className="btn btn-primary" href={`/batches/${summary.batch_id}`}>アップロード詳細でOCR開始</Link>
              <Link className="btn" href="/articles">記事一覧へ</Link>
              <Link className="btn" href="/chat">Chatで分析する</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
