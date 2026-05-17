'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const MAX_FILES = 20;
const ACTIVE_STATUSES = new Set(['圧縮中', '保存中', 'OCR中']);
const FINISHED_STATUSES = new Set(['完了', 'OCR待ち', '失敗']);

type Row = { name: string; status: string; note?: string };

type Result = { batchId: string; selected: number; saved: number; ocr: number; failed: number; articles: number };

function isBadFormat(file: File) {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

async function shrink(file: File): Promise<File> {
  if (isBadFormat(file)) throw new Error('JPGまたはPNGに変換してください');
  const bitmap = await createImageBitmap(file);
  const maxSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 2200 / maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を処理できません');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('画像圧縮に失敗しました')), 'image/jpeg', 0.82);
  });
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
}

export function UploadFormStable() {
  const password = useAppPassword();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [date, setDate] = useState('');
  const [autoOcr, setAutoOcr] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  function choose(list: File[]) {
    setFiles(list.slice(0, MAX_FILES));
    setRows([]);
    setResult(null);
    setMessage(list.length > MAX_FILES ? `最大${MAX_FILES}枚に絞りました` : '');
  }

  function patchRow(index: number, row: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => i === index ? { ...r, ...row } : r));
  }

  async function startBatch() {
    const res = await fetch('/api/upload/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ memo, article_date: date.trim(), image_count: files.length })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '開始に失敗しました');
    return String(json.batch.id);
  }

  async function uploadImage(batchId: string, file: File, index: number) {
    patchRow(index, { status: '圧縮中' });
    const out = await shrink(file);
    const form = new FormData();
    form.set('batch_id', batchId);
    form.set('index', String(index + 1));
    form.set('article_date', date.trim());
    form.set('file', out);
    patchRow(index, { status: '保存中', note: `${(out.size / 1024 / 1024).toFixed(1)}MB` });
    const res = await fetch('/api/upload/image', { method: 'POST', headers: { 'x-app-password': password }, body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '保存に失敗しました');
    return String(json.image.id);
  }

  async function runOcr(imageId: string, index: number) {
    patchRow(index, { status: 'OCR中' });
    const res = await fetch(`/api/source-images/${imageId}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ article_date: date.trim() })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'OCRに失敗しました');
    return Number(json.article_count || 0);
  }

  async function submit() {
    if (!files.length || busy) return;
    if (files.some(isBadFormat)) {
      setMessage('JPGまたはPNGに変換してください');
      return;
    }
    setBusy(true);
    setResult(null);
    setRows(files.map((f) => ({ name: f.name, status: '待機' })));
    setMessage('まとめて処理中です');

    let batchId = '';
    let saved = 0;
    let ocr = 0;
    let failed = 0;
    let articles = 0;
    try {
      batchId = await startBatch();
      for (let i = 0; i < files.length; i++) {
        try {
          const imageId = await uploadImage(batchId, files[i], i);
          saved += 1;
          if (autoOcr) {
            const count = await runOcr(imageId, i);
            ocr += 1;
            articles += count;
            patchRow(i, { status: '完了', note: `記事 ${count}件` });
          } else {
            patchRow(i, { status: 'OCR待ち' });
          }
        } catch (e) {
          failed += 1;
          patchRow(i, { status: '失敗', note: e instanceof Error ? e.message : '失敗' });
        }
      }
      setResult({ batchId, selected: files.length, saved, ocr, failed, articles });
      setMessage(autoOcr ? `完了：記事候補 ${articles}件` : '保存完了：詳細画面でOCRできます');
      if (saved > 0) setFiles([]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '失敗しました');
    } finally {
      setBusy(false);
    }
  }

  const totalCount = rows.length || files.length;
  const finishedCount = rows.filter((row) => FINISHED_STATUSES.has(row.status)).length;
  const activeIndex = rows.findIndex((row) => ACTIVE_STATUSES.has(row.status));
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : null;
  const failedCount = rows.filter((row) => row.status === '失敗').length;
  const progressPercent = totalCount ? Math.round((finishedCount / totalCount) * 100) : 0;
  const activeLabel = activeRow
    ? `現在処理中：${activeIndex + 1}/${totalCount} ${activeRow.status}`
    : busy && totalCount
      ? `処理準備中：0/${totalCount}`
      : totalCount && finishedCount === totalCount
        ? `処理完了：${finishedCount}/${totalCount}`
        : '';

  return <div className="card p-5">
    <h1 className="text-xl font-black">MJ画像アップロード</h1>
    <p className="mt-2 text-sm leading-6 text-zinc-600">画像をまとめて選択し、OCRと記事候補化まで実行します。</p>
    <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
      <b>使い方</b><br />
      1. 紙面の日付が分かる場合は「記事日付」に入力<br />
      2. 画像をまとめて選択<br />
      3. 「まとめてアップロードして記事化」を押す<br />
      4. 完了後は「記事一覧」または「アップロード詳細」で確認
    </div>
    <div className="mt-5 space-y-4">
      <textarea className="input min-h-20" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ：例 2026年5月中旬 / 食品・AI関連多め" />
      <input className="input" value={date} onChange={(e) => setDate(e.target.value)} placeholder="記事日付：例 2026-05-13" />
      <label className="flex gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm"><input type="checkbox" checked={autoOcr} onChange={(e) => setAutoOcr(e.target.checked)} />保存後にOCR・記事化する</label>
      <input className="input" type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => choose(Array.from(e.target.files || []))} disabled={busy} />
      <div className="flex flex-wrap gap-3 text-sm text-zinc-600"><span>選択中：{files.length}/{MAX_FILES}枚</span>{files.length > 0 && <button className="btn" onClick={() => { setFiles([]); setRows([]); setResult(null); }} disabled={busy}>全てクリア</button>}</div>

      {(busy || rows.length > 0) && totalCount > 0 && <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-bold">処理状況</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">{activeLabel || `処理済み：${finishedCount}/${totalCount}`}</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-zinc-600">
            <span className="badge">完了 {finishedCount}/{totalCount}</span>
            <span className="badge">失敗 {failedCount}</span>
            <span className="badge">{progressPercent}%</span>
          </div>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-zinc-200">
          <div className="h-full rounded-full bg-zinc-900 transition-all duration-300" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>}

      {files.length > 0 && <ul className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">{files.map((f, i) => <li key={`${f.name}-${i}`} className="flex justify-between gap-3 border-b border-zinc-200 py-2 last:border-b-0"><div>{i + 1}. {f.name}<p className={rows[i]?.status === '失敗' ? 'text-xs text-red-600' : 'text-xs text-zinc-500'}>{rows[i]?.status || '待機'} {rows[i]?.note || ''}</p></div><button className="btn" onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))} disabled={busy}>削除</button></li>)}</ul>}
      <button className="btn btn-primary" onClick={submit} disabled={!files.length || busy}>{busy ? '処理中' : autoOcr ? 'まとめてアップロードして記事化' : 'まとめてアップロード'}</button>
      {message && <p className="text-sm leading-6 text-zinc-700">{message}</p>}
      {result && <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4"><h2 className="font-bold">処理サマリー</h2><div className="mt-3 grid gap-2 text-sm md:grid-cols-5"><div className="rounded-xl bg-white p-3"><b>{result.selected}</b><br />選択</div><div className="rounded-xl bg-white p-3"><b>{result.saved}</b><br />保存</div><div className="rounded-xl bg-white p-3"><b>{result.ocr}</b><br />OCR</div><div className="rounded-xl bg-white p-3"><b>{result.failed}</b><br />失敗</div><div className="rounded-xl bg-white p-3"><b>{result.articles}</b><br />記事</div></div><div className="mt-4 flex flex-wrap gap-2"><Link className="btn btn-primary" href={`/batches/${result.batchId}`}>アップロード詳細</Link><Link className="btn" href="/articles">記事一覧</Link><Link className="btn" href="/chat">Chatで分析</Link></div></div>}
    </div>
  </div>;
}
