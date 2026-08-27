'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const MAX_FILES = 20;
const MAX_ATTEMPTS = 3;
const OCR_MAX_IMAGE_SIDE = 4200;
const OCR_JPEG_QUALITY = 0.95;

type Row = { name: string; status: string; note?: string };
type Result = {
  batchId: string;
  selected: number;
  saved: number;
  uploadFailed: number;
  ocrDone: number;
  ocrFailed: number;
  ocrChars: number;
};

function isBadFormat(file: File) {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

function sameNameIndexes(list: File[]) {
  const counts = new Map<string, number[]>();
  list.forEach((file, index) => counts.set(file.name, [...(counts.get(file.name) || []), index]));
  return Array.from(counts.entries()).filter(([, indexes]) => indexes.length > 1);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '失敗');
}

function isQuotaError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('429') || message.includes('quota') || message.includes('rate limit');
}

async function withRetry<T>(task: () => Promise<T>, onRetry: (attempt: number, message: string) => void): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (isQuotaError(error) || attempt >= MAX_ATTEMPTS) break;
      onRetry(attempt + 1, errorMessage(error));
      await sleep(Math.min(6000, 800 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

async function shrink(file: File): Promise<File> {
  if (isBadFormat(file)) throw new Error('JPGまたはPNGに変換してください');
  const bitmap = await createImageBitmap(file);
  const maxSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, OCR_MAX_IMAGE_SIDE / maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を処理できません');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('画像圧縮に失敗しました')), 'image/jpeg', OCR_JPEG_QUALITY);
  });
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
}

export function UploadFormOcrOnly() {
  const password = useAppPassword();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [date, setDate] = useState('');
  const [autoOcr, setAutoOcr] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const sameNames = useMemo(() => sameNameIndexes(files), [files]);

  function patchRow(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  }

  function choose(list: File[]) {
    setFiles(list.slice(0, MAX_FILES));
    setRows([]);
    setResult(null);
    if (list.length > MAX_FILES) {
      setMessage(`一度に${MAX_FILES}枚までです。先頭${MAX_FILES}枚を選択しました。`);
      return;
    }
    setMessage(sameNameIndexes(list).length ? '同じファイル名があります。重複を外してください。' : '選択しました。OCRは1枚ずつ順番に実行します。');
  }

  async function startBatch(imageCount: number) {
    const res = await fetch('/api/upload/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ memo, article_date: date.trim(), image_count: imageCount })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'バッチ作成に失敗しました');
    return String(json.batch.id);
  }

  async function uploadImage(batchId: string, file: File, index: number) {
    patchRow(index, { status: '圧縮中', note: undefined });
    const out = await shrink(file);
    const form = new FormData();
    form.set('batch_id', batchId);
    form.set('index', String(index + 1));
    form.set('article_date', date.trim());
    form.set('file', out);
    patchRow(index, { status: '保存中', note: `${(out.size / 1024 / 1024).toFixed(1)}MB` });
    const res = await fetch('/api/upload/image', {
      method: 'POST',
      headers: { 'x-app-password': password },
      body: form
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '保存に失敗しました');
    return String(json.image.id);
  }

  async function runOcr(imageId: string, index: number) {
    patchRow(index, { status: 'OCR中', note: 'Google DOCUMENT_TEXT_DETECTION' });
    const res = await fetch(`/api/source-images/${imageId}/ocr-only`, {
      method: 'POST',
      headers: { 'x-app-password': password }
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'OCRに失敗しました');
    return Number(json.ocr_char_count || 0);
  }

  async function submit() {
    if (!files.length || busy) return;
    if (sameNames.length) {
      setMessage('同じファイル名があります。重複を外してから実行してください。');
      return;
    }
    if (files.some(isBadFormat)) {
      setMessage('HEIC/HEIFはJPGまたはPNGへ変換してください。');
      return;
    }

    const targetFiles = [...files];
    setBusy(true);
    setResult(null);
    setRows(targetFiles.map((file) => ({ name: file.name, status: '待機' })));
    setMessage('保存→OCRの順で1枚ずつ処理します。記事化・分類・分析は実行しません。');

    let batchId = '';
    let saved = 0;
    let uploadFailed = 0;
    let ocrDone = 0;
    let ocrFailed = 0;
    let ocrChars = 0;
    let quotaStopped = false;
    const uploadFailures: File[] = [];

    try {
      batchId = await withRetry(
        () => startBatch(targetFiles.length),
        (attempt, msg) => setMessage(`バッチ作成 ${attempt}/${MAX_ATTEMPTS}回目を再試行中：${msg}`)
      );

      for (let i = 0; i < targetFiles.length; i++) {
        const file = targetFiles[i];
        let imageId = '';
        try {
          imageId = await withRetry(
            () => uploadImage(batchId, file, i),
            (attempt, msg) => patchRow(i, { status: '再試行中', note: `保存 ${attempt}/${MAX_ATTEMPTS}：${msg}` })
          );
          saved += 1;
        } catch (error) {
          uploadFailed += 1;
          uploadFailures.push(file);
          patchRow(i, { status: '失敗', note: `保存失敗：${errorMessage(error)}` });
          continue;
        }

        if (!autoOcr) {
          patchRow(i, { status: '保存済み', note: 'OCR待ち' });
          continue;
        }

        try {
          const charCount = await withRetry(
            () => runOcr(imageId, i),
            (attempt, msg) => patchRow(i, { status: '再試行中', note: `OCR ${attempt}/${MAX_ATTEMPTS}：${msg}` })
          );
          ocrDone += 1;
          ocrChars += charCount;
          patchRow(i, { status: '完了', note: `OCR ${charCount.toLocaleString()}文字` });
        } catch (error) {
          ocrFailed += 1;
          patchRow(i, { status: '保存済み', note: `OCR失敗：${errorMessage(error)} / OCRストック画面から再試行可` });
          if (isQuotaError(error)) {
            quotaStopped = true;
            setMessage('OCR APIの利用枠またはレート制限に到達しました。画像保存は維持し、残りはOCRストック画面から後で処理できます。');
            for (let j = i + 1; j < targetFiles.length; j++) {
              const pending = targetFiles[j];
              try {
                await withRetry(
                  () => uploadImage(batchId, pending, j),
                  (attempt, msg) => patchRow(j, { status: '再試行中', note: `保存 ${attempt}/${MAX_ATTEMPTS}：${msg}` })
                );
                saved += 1;
                patchRow(j, { status: '保存済み', note: 'OCR待ち' });
              } catch (uploadError) {
                uploadFailed += 1;
                uploadFailures.push(pending);
                patchRow(j, { status: '失敗', note: `保存失敗：${errorMessage(uploadError)}` });
              }
            }
            break;
          }
        }

        await sleep(350);
      }

      setResult({ batchId, selected: targetFiles.length, saved, uploadFailed, ocrDone, ocrFailed, ocrChars });
      if (uploadFailures.length > 0) {
        setFiles(uploadFailures);
        setRows(uploadFailures.map((file) => ({ name: file.name, status: '待機', note: '保存失敗分のみ再アップロード対象' })));
      } else {
        setFiles([]);
        setRows([]);
      }
      if (!quotaStopped) {
        setMessage(`完了：保存 ${saved}枚 / OCR完了 ${ocrDone}枚 / OCR失敗 ${ocrFailed}枚 / 保存失敗 ${uploadFailed}枚`);
      }
    } catch (error) {
      setMessage(`開始できませんでした：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h1 className="text-xl font-black">画像ストック＋OCR</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        画像をSupabase Storageへ保存し、必要ならGoogle OCRだけを1枚ずつ実行します。記事候補化、Embedding、分類、テーマ分析、レポート生成は実行しません。
      </p>

      <div className="mt-4 space-y-4">
        <textarea className="input min-h-20" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ：例 2026年8月 / 新聞ストック" />
        <input className="input" value={date} onChange={(e) => setDate(e.target.value)} placeholder="記事日付：例 2026-08-27（任意）" />
        <label className="flex gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <input type="checkbox" checked={autoOcr} onChange={(e) => setAutoOcr(e.target.checked)} />
          保存後にOCRする（逐次1枚・記事化なし）
        </label>
        <input className="input" type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => choose(Array.from(e.target.files || []))} disabled={busy} />

        <div className="flex flex-wrap gap-3 text-sm text-zinc-600">
          <span>選択中：{files.length}枚 / 最大{MAX_FILES}枚</span>
          {files.length > 0 && <button className="btn" type="button" onClick={() => { setFiles([]); setRows([]); setResult(null); setMessage('選択をクリアしました'); }} disabled={busy}>クリア</button>}
        </div>

        {sameNames.length > 0 && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            同名ファイルがあります：{sameNames.map(([name]) => name).join(' / ')}
          </div>
        )}

        {rows.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
            {rows.map((row, index) => (
              <div key={`${row.name}-${index}`} className="border-b border-zinc-200 py-2 last:border-b-0">
                <b>{index + 1}. {row.name}</b> <span className="badge ml-2">{row.status}</span>
                {row.note && <p className="mt-1 text-xs text-zinc-600">{row.note}</p>}
              </div>
            ))}
          </div>
        )}

        <button className="btn btn-primary" type="button" onClick={submit} disabled={!files.length || busy || sameNames.length > 0}>
          {busy ? '順番に処理中' : autoOcr ? '保存してOCRする' : '画像だけ保存する'}
        </button>

        {message && <p className="text-sm leading-6 text-zinc-700">{message}</p>}

        {result && (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <h2 className="font-bold">処理サマリー</h2>
            <div className="mt-3 grid gap-2 text-sm md:grid-cols-5">
              <div className="rounded-xl bg-white p-3"><b>{result.saved}</b><br />保存</div>
              <div className="rounded-xl bg-white p-3"><b>{result.ocrDone}</b><br />OCR完了</div>
              <div className="rounded-xl bg-white p-3"><b>{result.ocrFailed}</b><br />OCR失敗</div>
              <div className="rounded-xl bg-white p-3"><b>{result.uploadFailed}</b><br />保存失敗</div>
              <div className="rounded-xl bg-white p-3"><b>{result.ocrChars.toLocaleString()}</b><br />OCR文字</div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link className="btn btn-primary" href={`/ocr-stock/${result.batchId}`}>OCR結果を見る</Link>
              <Link className="btn" href="/ocr-stock">OCRストック一覧</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
