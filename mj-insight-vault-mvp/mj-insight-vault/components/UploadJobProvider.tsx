'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const ACTIVE_STATUSES = new Set(['圧縮中', '保存中', 'OCR中', '再試行中']);
const FINISHED_STATUSES = new Set(['完了', 'OCR待ち', '失敗']);
const DRAFT_DB = 'mj-upload-draft-v1';
const DRAFT_STORE = 'draft';
const DRAFT_KEY = 'current';
const MAX_ATTEMPTS = 3;

type Row = { name: string; status: string; note?: string };
type Result = { batchId: string; selected: number; saved: number; ocr: number; failed: number; articles: number };
type StoredDraftFile = { name: string; type: string; lastModified: number; blob: Blob };
type UploadDraft = { memo: string; date: string; autoOcr: boolean; files: StoredDraftFile[]; savedAt: number };
type SameName = [string, number[]];

type UploadJobValue = {
  files: File[];
  memo: string;
  date: string;
  autoOcr: boolean;
  busy: boolean;
  rows: Row[];
  message: string;
  result: Result | null;
  sameNames: SameName[];
  sameNameSet: Set<number>;
  totalCount: number;
  finishedCount: number;
  failedCount: number;
  progressPercent: number;
  activeLabel: string;
  setMemo: (value: string) => void;
  setDate: (value: string) => void;
  setAutoOcr: (value: boolean) => void;
  choose: (list: File[]) => void;
  removeFile: (index: number) => void;
  clearSelection: () => void;
  keepFirstSameNames: () => void;
  submit: () => Promise<void>;
};

const UploadJobContext = createContext<UploadJobValue | null>(null);

export function useUploadJob() {
  const value = useContext(UploadJobContext);
  if (!value) throw new Error('useUploadJob must be used inside UploadJobProvider');
  return value;
}

function isBadFormat(file: File) {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

function sameNameIndexes(list: File[]): SameName[] {
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '失敗';
}

async function withRetry<T>(task: () => Promise<T>, onRetry: (attempt: number, message: string) => void): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS) break;
      onRetry(attempt + 1, errorMessage(error));
      await sleep(retryDelay(attempt));
    }
  }
  throw lastError;
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is unavailable'));
    const request = indexedDB.open(DRAFT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE)) request.result.createObjectStore(DRAFT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('draft db error'));
  });
}

async function readDraft(): Promise<UploadDraft | null> {
  const db = await openDraftDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, 'readonly');
    const request = tx.objectStore(DRAFT_STORE).get(DRAFT_KEY);
    request.onsuccess = () => resolve((request.result as UploadDraft | undefined) || null);
    request.onerror = () => reject(request.error || new Error('draft read error'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function writeDraft(draft: UploadDraft) {
  const db = await openDraftDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, 'readwrite');
    tx.objectStore(DRAFT_STORE).put(draft, DRAFT_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('draft write error')); };
  });
}

async function clearDraft() {
  const db = await openDraftDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, 'readwrite');
    tx.objectStore(DRAFT_STORE).delete(DRAFT_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('draft clear error')); };
  });
}

function toStoredFile(file: File): StoredDraftFile {
  return { name: file.name, type: file.type, lastModified: file.lastModified, blob: file };
}

function fromStoredFile(file: StoredDraftFile) {
  return new File([file.blob], file.name, { type: file.type, lastModified: file.lastModified });
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

export function UploadJobProvider({ children }: { children: React.ReactNode }) {
  const password = useAppPassword();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [date, setDate] = useState('');
  const [autoOcr, setAutoOcr] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [draftReady, setDraftReady] = useState(false);

  const sameNames = useMemo(() => sameNameIndexes(files), [files]);
  const sameNameSet = useMemo(() => new Set(sameNames.flatMap(([, indexes]) => indexes)), [sameNames]);

  useEffect(() => {
    let cancelled = false;
    readDraft()
      .then((draft) => {
        if (cancelled || !draft) return;
        setMemo(draft.memo || '');
        setDate(draft.date || '');
        setAutoOcr(draft.autoOcr !== false);
        const restoredFiles = (draft.files || []).map(fromStoredFile);
        if (restoredFiles.length) {
          setFiles(restoredFiles);
          setMessage(`前回選択した画像 ${restoredFiles.length}枚を復元しました`);
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setDraftReady(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      const hasDraft = files.length > 0 || memo.trim() || date.trim() || autoOcr !== true;
      if (!hasDraft) {
        clearDraft().catch(() => undefined);
        return;
      }
      writeDraft({ memo, date, autoOcr, files: files.map(toStoredFile), savedAt: Date.now() }).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [files, memo, date, autoOcr, draftReady]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [busy]);

  function choose(list: File[]) {
    setFiles(list);
    setRows([]);
    setResult(null);
    setMessage(sameNameIndexes(list).length ? '同じファイル名があります。不要な方を外してからアップロードしてください。' : '選択内容を一時保存しました');
  }

  function removeFile(index: number) {
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    setRows([]);
    setResult(null);
    setMessage(sameNameIndexes(next).length ? '同じファイル名があります。不要な方を外してからアップロードしてください。' : '選択内容を更新しました');
  }

  function clearSelection() {
    setFiles([]);
    setRows([]);
    setResult(null);
    setMessage('選択中の画像をクリアしました');
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
    setMessage('同じファイル名の2件目以降を外しました');
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
    if (sameNameIndexes(files).length) {
      setMessage('同じファイル名があります。不要な方を外してからアップロードしてください。');
      return;
    }
    if (files.some(isBadFormat)) {
      setMessage('JPGまたはPNGに変換してください');
      return;
    }

    setBusy(true);
    setResult(null);
    setRows(files.map((f) => ({ name: f.name, status: '待機' })));
    setMessage('まとめて処理中です。失敗時は自動で最大3回まで再試行します。');

    let batchId = '';
    let saved = 0;
    let ocr = 0;
    let failed = 0;
    let articles = 0;
    try {
      batchId = await withRetry(
        () => startBatch(),
        (attempt, msg) => setMessage(`アップロード開始に失敗しました。${attempt}/${MAX_ATTEMPTS}回目を再試行中：${msg}`)
      );

      for (let i = 0; i < files.length; i++) {
        try {
          const imageId = await withRetry(
            () => uploadImage(batchId, files[i], i),
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
        } catch (e) {
          failed += 1;
          patchRow(i, { status: '失敗', note: `${MAX_ATTEMPTS}回試行後に失敗：${errorMessage(e)}` });
        }
      }
      setResult({ batchId, selected: files.length, saved, ocr, failed, articles });
      setMessage(autoOcr ? `完了：記事候補 ${articles}件 / 失敗 ${failed}件` : `保存完了：失敗 ${failed}件。詳細画面でOCRできます`);
      if (saved > 0 && failed === 0) {
        setFiles([]);
        clearDraft().catch(() => undefined);
      }
    } catch (e) {
      setMessage(`${MAX_ATTEMPTS}回試行後に失敗しました：${errorMessage(e)}`);
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

  return <UploadJobContext.Provider value={{ files, memo, date, autoOcr, busy, rows, message, result, sameNames, sameNameSet, totalCount, finishedCount, failedCount, progressPercent, activeLabel, setMemo, setDate, setAutoOcr, choose, removeFile, clearSelection, keepFirstSameNames, submit }}>{children}</UploadJobContext.Provider>;
}
