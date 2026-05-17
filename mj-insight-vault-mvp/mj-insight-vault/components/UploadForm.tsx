'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const MAX_FILES = 20;
const MAX_COMPRESSED_FILE_MB = 3.5;
const TARGET_MAX_DIMENSION = 2200;
const JPEG_QUALITY = 0.82;

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

type UploadProgress = {
  file_name: string;
  original_mb: number;
  upload_mb?: number;
  status: 'waiting' | 'compressing' | 'uploading' | 'done' | 'failed';
  message?: string;
};

function mb(bytes: number) {
  return bytes / 1024 / 1024;
}

function isHeic(file: File) {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

async function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('画像圧縮に失敗しました'));
      else resolve(blob);
    }, 'image/jpeg', quality);
  });
}

async function compressImage(file: File) {
  if (isHeic(file)) throw new Error('HEIC/HEIFは非対応です。JPGまたはPNGに変換してください。');

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, TARGET_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像圧縮用Canvasを作成できません');

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let quality = JPEG_QUALITY;
  let blob = await canvasToBlob(canvas, quality);

  while (blob.size > MAX_COMPRESSED_FILE_MB * 1024 * 1024 && quality > 0.48) {
    quality -= 0.08;
    blob = await canvasToBlob(canvas, quality);
  }

  const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
  const compressedFile = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });

  return {
    file: compressedFile,
    originalMb: mb(file.size),
    uploadMb: mb(compressedFile.size),
    width,
    height
  };
}

export function UploadForm() {
  const password = useAppPassword();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [articleDate, setArticleDate] = useState('');
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress[]>([]);

  const heicFiles = useMemo(() => files.filter(isHeic), [files]);
  const totalOriginalMb = useMemo(() => files.reduce((sum, file) => sum + mb(file.size), 0), [files]);

  function selectFiles(nextFiles: File[]) {
    setSummary(null);
    setProgress([]);

    if (nextFiles.length > MAX_FILES) {
      setStatus(`最大${MAX_FILES}枚までです。${MAX_FILES}枚に絞りました。不要な画像を削除して再実行してください。`);
    } else {
      setStatus('');
    }

    setFiles(nextFiles.slice(0, MAX_FILES));
  }

  function removeFile(index: number) {
    setSummary(null);
    setProgress([]);
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function clearFiles() {
    setFiles([]);
    setSummary(null);
    setProgress([]);
    setStatus('選択画像をクリアしました。');
  }

  function updateProgress(index: number, patch: Partial<UploadProgress>) {
    setProgress((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
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

    setBusy(true);
    setSummary(null);
    setProgress(files.map((file) => ({ file_name: file.name, original_mb: mb(file.size), status: 'waiting' })));
    setStatus('画像を1枚ずつ圧縮して保存しています。4枚程度でも落ちる主因は、複数画像を1リクエストに詰めてVercelの本文サイズ制限に当たることです。');

    let batchId = '';
    let successCount = 0;
    let failedCount = 0;

    try {
      const startRes = await fetch('/api/upload/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ memo, article_date: articleDate.trim(), image_count: files.length })
      });

      const startJson = await startRes.json();
      if (!startRes.ok) throw new Error(startJson.error || 'アップロード開始に失敗しました');
      batchId = startJson.batch.id;

      for (let i = 0; i < files.length; i++) {
        const sourceFile = files[i];

        try {
          updateProgress(i, { status: 'compressing', message: '圧縮中' });
          const compressed = await compressImage(sourceFile);

          if (compressed.file.size > MAX_COMPRESSED_FILE_MB * 1024 * 1024) {
            throw new Error(`圧縮後も${MAX_COMPRESSED_FILE_MB}MBを超えています。元画像をトリミングまたは低解像度化してください。`);
          }

          updateProgress(i, {
            status: 'uploading',
            upload_mb: compressed.uploadMb,
            message: `${compressed.width}x${compressed.height}px / ${compressed.uploadMb.toFixed(1)}MB を送信中`
          });

          const form = new FormData();
          form.set('batch_id', batchId);
          form.set('article_date', articleDate.trim());
          form.set('index', String(i + 1));
          form.set('file', compressed.file);

          const res = await fetch('/api/upload/image', {
            method: 'POST',
            headers: { 'x-app-password': password },
            body: form
          });

          const json = await res.json();
          if (!res.ok) throw new Error(json.error || '画像保存に失敗しました');

          successCount += 1;
          updateProgress(i, { status: 'done', message: '保存完了' });
        } catch (error) {
          failedCount += 1;
          updateProgress(i, { status: 'failed', message: error instanceof Error ? error.message : '画像保存に失敗しました' });
        }
      }

      setSummary({
        batch_id: batchId,
        image_count: files.length,
        success_image_count: 0,
        failed_image_count: failedCount,
        article_count: 0,
        date_unknown_count: 0,
        queued_image_count: successCount,
        mode: 'queued'
      });

      setStatus(
        failedCount
          ? `画像保存が完了しました。成功 ${successCount} 枚、失敗 ${failedCount} 枚。失敗理由を確認してください。`
          : '画像保存が完了しました。アップロード詳細で「未処理画像を順番にOCR」を押してください。'
      );

      if (successCount > 0) setFiles([]);
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
        最大{MAX_FILES}枚。画像はブラウザ側で圧縮し、1枚ずつ保存します。複数画像をまとめて送らないため、Vercelの本文サイズ制限に当たりにくくなっています。
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

        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
          <b>失敗要因の対策：</b>以前は複数画像を1回のPOSTにまとめていたため、4枚でも合計サイズが大きいとVercelのリクエスト本文制限で落ちました。現在は、ブラウザでJPG圧縮して1枚ずつ送ります。
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600">
          <span>選択中：{files.length}/{MAX_FILES}枚</span>
          <span>元サイズ合計：約{totalOriginalMb.toFixed(1)}MB</span>
          {files.length > 0 && <button className="btn" type="button" onClick={clearFiles} disabled={busy}>全てクリア</button>}
        </div>

        {files.length > 0 && (
          <ul className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
            {files.map((file, index) => {
              const item = progress[index];
              return (
                <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 border-b border-zinc-200 py-2 last:border-b-0">
                  <div>
                    <span>{index + 1}. {file.name} / {mb(file.size).toFixed(1)}MB</span>
                    {item && (
                      <p className={item.status === 'failed' ? 'mt-1 text-xs text-red-600' : 'mt-1 text-xs text-zinc-500'}>
                        {item.status} {typeof item.upload_mb === 'number' ? `/ 送信 ${item.upload_mb.toFixed(1)}MB` : ''} {item.message || ''}
                      </p>
                    )}
                  </div>
                  <button className="btn shrink-0" type="button" onClick={() => removeFile(index)} disabled={busy}>削除</button>
                </li>
              );
            })}
          </ul>
        )}

        <button className="btn btn-primary" onClick={upload} disabled={!files.length || busy || heicFiles.length > 0}>
          {busy ? '保存中' : '画像を1枚ずつ保存して処理待ちにする'}
        </button>

        {status && <p className="text-sm leading-6 text-zinc-700">{status}</p>}

        {summary && (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <h2 className="font-bold">アップロード保存サマリー</h2>
            <div className="mt-3 grid gap-2 text-sm md:grid-cols-5">
              <div className="rounded-xl bg-white p-3"><b>{summary.image_count}</b><br />選択画像</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.queued_image_count ?? summary.image_count}</b><br />処理待ち</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.failed_image_count}</b><br />保存失敗</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.article_count}</b><br />記事候補</div>
              <div className="rounded-xl bg-white p-3"><b>{summary.mode || 'queued'}</b><br />方式</div>
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
