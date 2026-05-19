'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';
import {
  clearUploadDraft,
  fileToStoredDraftFile,
  readUploadDraft,
  storedDraftFileToFile,
  writeUploadDraft,
  type UploadDraft
} from '@/lib/uploadDraftStore';

const ACTIVE_STATUSES = new Set(['圧縮中', '保存中', 'OCR中', '再試行中']);
const FINISHED_STATUSES = new Set(['完了', 'OCR待ち', '失敗']);
const MAX_ATTEMPTS = 3;
const OCR_MAX_IMAGE_SIDE = 4200;
const OCR_JPEG_QUALITY = 0.95;

type Row = { name: string; status: string; note?: string };
type Result = { batchId: string; selected: number; saved: number; ocr: number; failed: number; articles: number };

type FailedFile = { file: File; row: Row };

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

function retryDelay(attempt: number) {
  return Math.min(8000, 1000 * Math.pow(2, attempt - 1));
}

function errMsg(error: unknown) {
  return error instanceof Error ? error.message : '失敗';
}

function formatSavedAt(value: number) {
  if (!value) return '不明';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '不明';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isRestorableRow(row?: Row) {
  return !row || (row.status !== '完了' && row.status !== 'OCR待ち');
}

function toRestoredRow(file: File, row?: Row): Row {
  if (row?.status === '失敗') return row;
  return {
    name: row?.name || file.name,
    status: '待機',
    note: row ? `復元した未完了アップロード（元状態：${row.status}）` : '復元した未完了アップロード'
  };
}

async function withRetry<T>(task: () => Promise<T>, onRetry: (attempt: number, message: string) => void): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS) break;
      onRetry(attempt + 1, errMsg(error));
      await sleep(retryDelay(attempt));
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
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('画像圧縮に失敗しました')), 'image/jpeg', OCR_JPEG_QUALITY);
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
  const [failedFiles, setFailedFiles] = useState<FailedFile[]>([]);
  const [batchIdState, setBatchIdState] = useState('');
  const [recoverableDraft, setRecoverableDraft] = useState<UploadDraft | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState('');

  const sameNames = useMemo(() => sameNameIndexes(files), [files]);
  const sameNameSet = useMemo(() => new Set(sameNames.flatMap(([, indexes]) => indexes)), [sameNames]);
  const recoverableFailedCount = recoverableDraft?.rows.filter((row) => row.status === '失敗').length || 0;
  const recoverableTargetCount = recoverableDraft ? recoverableDraft.files.filter((_, index) => isRestorableRow(recoverableDraft.rows[index])).length : 0;

  useEffect(() => {
    let cancelled = false;
    readUploadDraft()
      .then((draft) => {
        if (cancelled || !draft) return;
        if ((draft.files?.length || 0) > 0 || (draft.rows?.length || 0) > 0) {
          setRecoverableDraft(draft);
        }
      })
      .finally(() => {
        if (!cancelled) setDraftReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [busy]);

  useEffect(() => {
    if (!draftReady) return;

    const hasLocalDraft = files.length > 0 || rows.length > 0 || Boolean(memo.trim()) || Boolean(date.trim()) || Boolean(batchIdState);
    const onlyShowingRecoverableDraft = recoverableDraft && !hasLocalDraft && autoOcr === true;
    if (onlyShowingRecoverableDraft) return;

    const timer = window.setTimeout(() => {
      if (!hasLocalDraft && autoOcr === true) {
        clearUploadDraft();
        return;
      }

      writeUploadDraft({
        version: 1,
        memo,
        date,
        autoOcr,
        batchId: batchIdState || result?.batchId || undefined,
        rows,
        files: files.map(fileToStoredDraftFile),
        savedAt: Date.now()
      });
    }, 600);

    return () => window.clearTimeout(timer);
  }, [files, rows, memo, date, autoOcr, batchIdState, result?.batchId, draftReady, recoverableDraft]);

  function patchRow(index: number, row: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => i === index ? { ...r, ...row } : r));
  }

  function choose(list: File[]) {
    setFiles(list);
    setRows([]);
    setResult(null);
    setFailedFiles([]);
    setBatchIdState('');
    setRecoverableDraft(null);
    const found = sameNameIndexes(list);
    setMessage(found.length ? '同じファイル名があります。不要な方を外してからアップロードしてください。' : '選択しました。ページ更新時に復元できるよう一時保存します。');
  }

  function removeFile(index: number) {
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    setRows([]);
    setResult(null);
    setFailedFiles([]);
    setMessage(sameNameIndexes(next).length ? '同じファイル名があります。不要な方を外してください。' : '選択内容を更新しました');
  }

  function clearSelection() {
    setFiles([]);
    setRows([]);
    setResult(null);
    setFailedFiles([]);
    setBatchIdState('');
    setRecoverableDraft(null);
    clearUploadDraft();
    setMessage('選択中の画像をクリアしました');
  }

  function discardDraft() {
    setRecoverableDraft(null);
    clearUploadDraft();
    setDraftStatus('前回の未完了アップロードを破棄しました');
  }

  function restoreDraft() {
    if (!recoverableDraft) return;
    const allFiles = (recoverableDraft.files || []).map(storedDraftFileToFile);
    const allRows = recoverableDraft.rows || [];
    const pairs = allFiles
      .map((file, index) => ({ file, row: allRows[index] }))
      .filter(({ row }) => isRestorableRow(row));

    if (!pairs.length) {
      setFiles([]);
      setRows([]);
      setResult(null);
      setFailedFiles([]);
      setBatchIdState('');
      setRecoverableDraft(null);
      clearUploadDraft();
      setMessage('前回のアップロードはすべて処理済みだったため、復元対象はありません。');
      return;
    }

    const restoredFiles = pairs.map(({ file }) => file);
    const restoredRows = pairs.map(({ file, row }) => toRestoredRow(file, row));
    setFiles(restoredFiles);
    setRows(restoredRows);
    setMemo(recoverableDraft.memo || '');
    setDate(recoverableDraft.date || '');
    setAutoOcr(recoverableDraft.autoOcr !== false);
    setBatchIdState('');
    setResult(null);
    setFailedFiles(restoredRows
      .map((row, index) => row.status === '失敗' && restoredFiles[index] ? { file: restoredFiles[index], row } : null)
      .filter((item): item is FailedFile => Boolean(item)));
    setRecoverableDraft(null);
    setDraftStatus('');
    setMessage(`前回の未完了・失敗アップロード ${restoredFiles.length}枚を復元しました。必要に応じて再度アップロードしてください。`);
  }

  function keepFirstSameNames() {
    const seen = new Set<string>();
    const next = files.filter((file) => {
      if (seen.has(file.name)) return false;
      seen.add(file.name);
      return true;
    });
    setFiles(next);
    setRows([]);
    setResult(null);
    setFailedFiles([]);
    setMessage('同じファイル名の2件目以降を外しました');
  }

  function keepFailedOnly() {
    const onlyFailed = failedFiles.map((x) => x.file);
    setFiles(onlyFailed);
    setRows(failedFiles.map((x) => ({ ...x.row, status: '待機', note: '再アップロード対象' })));
    setResult(null);
    setBatchIdState('');
    setMessage(`失敗した画像 ${onlyFailed.length}枚だけを再選択しました。再度アップロードできます。`);
  }

  async function startBatch(imageCount = files.length) {
    const res = await fetch('/api/upload/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ memo, article_date: date.trim(), image_count: imageCount })
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
    patchRow(index, { status: '保存中', note: `${(out.size / 1024 / 1024).toFixed(1)}MB / OCR高画質` });
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
    if (sameNames.length) {
      setMessage('同じファイル名があります。不要な方を外してからアップロードしてください。');
      return;
    }
    if (files.some(isBadFormat)) {
      setMessage('JPGまたはPNGに変換してください');
      return;
    }

    const targetFiles = [...files];
    setBusy(true);
    setResult(null);
    setFailedFiles([]);
    setBatchIdState('');
    setRecoverableDraft(null);
    setRows(targetFiles.map((f) => ({ name: f.name, status: '待機' })));
    setMessage('まとめて処理中です。失敗時は最大3回まで自動再試行します。OCR高画質設定で保存します。');

    let localBatchId = '';
    let saved = 0;
    let ocr = 0;
    let failed = 0;
    let articles = 0;
    const failedNext: FailedFile[] = [];

    try {
      localBatchId = await withRetry(
        () => startBatch(targetFiles.length),
        (attempt, msg) => setMessage(`開始に失敗しました。${attempt}/${MAX_ATTEMPTS}回目を再試行中：${msg}`)
      );
      setBatchIdState(localBatchId);

      for (let i = 0; i < targetFiles.length; i++) {
        try {
          const imageId = await withRetry(
            () => uploadImage(localBatchId, targetFiles[i], i),
            (attempt, msg) => patchRow(i, { status: '再試行中', note: `保存 ${attempt}/${MAX_ATTEMPTS}回目：${msg}` })
          );
          saved += 1;
          if (autoOcr) {
            const count = await withRetry(
              () => runOcr(imageId, i),
              (attempt, msg) => patchRow(i, { status: '再試行中', note: `OCR ${attempt}/${MAX_ATTEMPTS}回目：${msg}` })
            );
            ocr += 1;
            articles += count;
            patchRow(i, { status: '完了', note: `記事 ${count}件` });
          } else {
            patchRow(i, { status: 'OCR待ち' });
          }
        } catch (error) {
          failed += 1;
          const row = { name: targetFiles[i].name, status: '失敗', note: `${MAX_ATTEMPTS}回試行後に失敗：${errMsg(error)}` };
          failedNext.push({ file: targetFiles[i], row });
          patchRow(i, row);
        }
      }

      setFailedFiles(failedNext);
      setResult({ batchId: localBatchId, selected: targetFiles.length, saved, ocr, failed, articles });
      if (failedNext.length) {
        setFiles(failedNext.map((x) => x.file));
        setRows(failedNext.map((x) => x.row));
        setMessage(`完了：成功 ${saved}枚 / 失敗 ${failedNext.length}枚。失敗分だけ画面に残しました。再度アップロードできます。`);
      } else {
        setFiles([]);
        setRows([]);
        setFailedFiles([]);
        setBatchIdState('');
        clearUploadDraft();
        setMessage(autoOcr ? `完了：記事候補 ${articles}件` : '保存完了：詳細画面でOCRできます');
      }
    } catch (error) {
      setMessage(`${MAX_ATTEMPTS}回試行後に失敗しました：${errMsg(error)}`);
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
  const activeLabel = activeRow ? `現在処理中：${activeIndex + 1}/${totalCount} ${activeRow.status}` : busy && totalCount ? `処理準備中：0/${totalCount}` : totalCount && finishedCount === totalCount ? `処理完了：${finishedCount}/${totalCount}` : '';

  return <div className="card p-5">
    <h1 className="text-xl font-black">MJ画像アップロード</h1>
    <p className="mt-2 text-sm leading-6 text-zinc-600">画像をまとめて選択し、OCRと記事候補化まで実行します。失敗した画像は画面に残るので、その分だけ再アップロードできます。選択中の画像と進行状態はブラウザ内に一時保存します。</p>
    <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
      <b>使い方</b><br />
      1. 紙面の日付が分かる場合は「記事日付」に入力<br />
      2. 画像をまとめて選択<br />
      3. 同じファイル名がある場合は不要な方を外す<br />
      4. 「まとめてアップロードして記事化」を押す<br />
      5. 失敗した画像がある場合は、その画像だけが残るので再度アップロード<br />
      <span className="text-zinc-500">OCRは最大辺{OCR_MAX_IMAGE_SIDE}px・JPEG品質{OCR_JPEG_QUALITY}の高画質設定で保存します。</span>
    </div>

    {recoverableDraft && <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="font-bold">前回の未完了アップロードがあります</h2>
          <p className="mt-1">復元対象 {recoverableTargetCount}枚 / 保存画像 {recoverableDraft.files.length}枚 / 失敗 {recoverableFailedCount}件 / 最終保存 {formatSavedAt(recoverableDraft.savedAt)}</p>
          <p className="mt-1 text-amber-900">自動では再開しません。復元後に未完了・失敗分だけ再度アップロードしてください。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" onClick={restoreDraft} disabled={busy}>前回の未完了アップロードを復元</button>
          <button className="btn" onClick={discardDraft} disabled={busy}>破棄</button>
        </div>
      </div>
    </div>}
    {draftStatus && <p className="mt-3 text-sm leading-6 text-zinc-600">{draftStatus}</p>}

    <div className="mt-5 space-y-4">
      <textarea className="input min-h-20" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ：例 2026年5月中旬 / 食品・AI関連多め" />
      <input className="input" value={date} onChange={(e) => setDate(e.target.value)} placeholder="記事日付：例 2026-05-13" />
      <label className="flex gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm"><input type="checkbox" checked={autoOcr} onChange={(e) => setAutoOcr(e.target.checked)} />保存後にOCR・記事化する</label>
      <input className="input" type="file" accept="image/*,.heic,.heif" multiple onChange={(e) => choose(Array.from(e.target.files || []))} disabled={busy} />
      <div className="flex flex-wrap gap-3 text-sm text-zinc-600"><span>選択中：{files.length}枚</span>{files.length > 0 && <button className="btn" onClick={clearSelection} disabled={busy}>選択をクリア</button>}{failedFiles.length > 0 && <button className="btn" onClick={keepFailedOnly} disabled={busy}>失敗分だけ再選択</button>}</div>

      {files.length > 30 && !busy && <p className="rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">選択数が多いほど処理時間と失敗率は上がります。失敗した場合は失敗分だけ再アップロードできます。</p>}

      {sameNames.length > 0 && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><h2 className="font-bold">同じファイル名があります</h2><p className="mt-1">このままではアップロードできません。不要な方を外してください。</p></div><button className="btn" onClick={keepFirstSameNames} disabled={busy}>2件目以降を外す</button></div>
        <ul className="mt-3 space-y-1">{sameNames.map(([name, indexes]) => <li key={name}>{name}：{indexes.map((index) => `${index + 1}番`).join(' / ')}</li>)}</ul>
      </div>}

      {(busy || rows.length > 0) && totalCount > 0 && <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between"><div><h2 className="font-bold">処理状況</h2><p className="mt-1 text-sm leading-6 text-zinc-600">{activeLabel || `処理済み：${finishedCount}/${totalCount}`}</p></div><div className="flex flex-wrap gap-2 text-xs text-zinc-600"><span className="badge">完了 {finishedCount}/{totalCount}</span><span className="badge">失敗 {failedCount}</span><span className="badge">{progressPercent}%</span></div></div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-zinc-200"><div className="h-full rounded-full bg-zinc-900 transition-all duration-300" style={{ width: `${progressPercent}%` }} /></div>
      </div>}

      {files.length > 0 && <ul className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">{files.map((f, i) => <li key={`${f.name}-${i}`} className="flex justify-between gap-3 border-b border-zinc-200 py-2 last:border-b-0"><div>{i + 1}. {f.name}{sameNameSet.has(i) && <span className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">同名</span>}<p className={rows[i]?.status === '失敗' ? 'text-xs text-red-600' : 'text-xs text-zinc-500'}>{rows[i]?.status || '待機'} {rows[i]?.note || ''}</p></div><button className="btn" onClick={() => removeFile(i)} disabled={busy}>{sameNameSet.has(i) ? '外す' : '削除'}</button></li>)}</ul>}

      <button className="btn btn-primary" onClick={submit} disabled={!files.length || busy || sameNames.length > 0}>{busy ? '処理中' : autoOcr ? 'まとめてアップロードして記事化' : 'まとめてアップロード'}</button>
      {message && <p className="text-sm leading-6 text-zinc-700">{message}</p>}
      {result && <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4"><h2 className="font-bold">処理サマリー</h2><div className="mt-3 grid gap-2 text-sm md:grid-cols-5"><div className="rounded-xl bg-white p-3"><b>{result.selected}</b><br />選択</div><div className="rounded-xl bg-white p-3"><b>{result.saved}</b><br />保存</div><div className="rounded-xl bg-white p-3"><b>{result.ocr}</b><br />OCR</div><div className="rounded-xl bg-white p-3"><b>{result.failed}</b><br />失敗</div><div className="rounded-xl bg-white p-3"><b>{result.articles}</b><br />記事</div></div><div className="mt-4 flex flex-wrap gap-2"><Link className="btn btn-primary" href={`/batches/${result.batchId}`}>アップロード詳細</Link><Link className="btn" href="/articles">記事一覧</Link><Link className="btn" href="/chat">Chatで分析</Link></div></div>}
    </div>
  </div>;
}
