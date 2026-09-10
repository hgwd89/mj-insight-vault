'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DRIVE_URL = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';
const MAX_UPLOAD_FILES = 100;
const UPLOAD_CONCURRENCY = 3;
const MAX_UPLOAD_FILE_BYTES = 3.5 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

type QueueRow = {
  source_file_id?: string;
  id?: string;
  file_name?: string;
};

type Progress = {
  completed: number;
  total: number;
  failed: number;
};

function japaneseError(message: string) {
  const text = message.trim();
  if (!text) return '処理に失敗しました。';
  if (/missing or null origin/i.test(text) || /origin header is required/i.test(text)) return '認証情報の確認に失敗しました。ページを再読み込みしてください。';
  if (/google oauth/i.test(text)) return 'Googleドライブへの接続に失敗しました。';
  if (/google drive/i.test(text) && /(failed|error|取得できません)/i.test(text)) return 'Googleドライブの資料を取得できませんでした。';
  if (/quota|rate limit|insufficient_quota/i.test(text)) return 'AI処理の利用上限に達しました。時間をおいて再実行してください。';
  if (/neon/i.test(text) && /(failed|error)/i.test(text)) return 'データベースへの登録または検索に失敗しました。';
  if (/http\s*4\d\d/i.test(text)) return '入力内容または認証状態を確認してください。';
  if (/http\s*5\d\d/i.test(text)) return 'サーバー側の処理に失敗しました。時間をおいて再度実行してください。';
  return text;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(japaneseError(String(json.error || `HTTP ${res.status}`)));
  return json;
}

function isAllowedUploadFile(file: File) {
  const type = (file.type || '').toLowerCase();
  const isPdfByName = file.name.toLowerCase().endsWith('.pdf');
  return file.size > 0
    && file.size <= MAX_UPLOAD_FILE_BYTES
    && (ALLOWED_UPLOAD_TYPES.has(type) || isPdfByName);
}

export function DriveNeonSimpleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('接続を確認しています…');
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [pendingOcr, setPendingOcr] = useState(0);
  const [optionalOrganize, setOptionalOrganize] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Progress>({ completed: 0, total: 0, failed: 0 });

  async function loadPendingOcr() {
    const res = await fetch('/api/cloud-stock/files?mode=pending_ocr', {
      headers: { 'x-app-password': appPassword }
    });
    const json = await readJson(res);
    const rows = Array.isArray(json.rows) ? json.rows as QueueRow[] : [];
    const total = Number.isFinite(Number(json.total)) ? Math.max(0, Number(json.total)) : rows.length;
    setPendingOcr(total);
    return { rows, total };
  }

  async function loadOptionalOrganize() {
    const res = await fetch('/api/cloud-stock/organize', {
      headers: { 'x-app-password': appPassword }
    });
    const json = await readJson(res);
    const rows = Array.isArray(json.rows) ? json.rows as QueueRow[] : [];
    const total = Number.isFinite(Number(json.total)) ? Math.max(0, Number(json.total)) : rows.length;
    setOptionalOrganize(total);
    return { rows, total };
  }

  async function refreshQueues() {
    const [ocr, organize] = await Promise.all([loadPendingOcr(), loadOptionalOrganize()]);
    return { ocr, organize };
  }

  useEffect(() => {
    if (!appPassword) return;
    void (async () => {
      try {
        const auth = await fetch('/api/cloud-stock/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
          body: JSON.stringify({ action: 'auto' })
        });
        await readJson(auth);
        const queues = await refreshQueues();
        setReady(true);
        setMessage(`未OCR ${queues.ocr.total}件／記事分割未実施 ${queues.organize.total}件（任意・GPT検索には不要）`);
      } catch (error) {
        setReady(false);
        setMessage(japaneseError(error instanceof Error ? error.message : '接続に失敗しました。'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      void refreshQueues().catch(() => null);
    }, 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  function chooseUploadFiles(files: File[]) {
    const eligible = files.filter(isAllowedUploadFile);
    const limited = eligible.slice(0, MAX_UPLOAD_FILES);
    const invalid = files.length - eligible.length;
    const overflow = eligible.length - limited.length;
    setSelectedFiles(limited);
    setUploadProgress({ completed: 0, total: limited.length, failed: 0 });

    const notes = [`${limited.length}件を選択しました`];
    if (overflow > 0) notes.push(`上限超過 ${overflow}件は除外`);
    if (invalid > 0) notes.push(`形式・サイズ条件外 ${invalid}件は除外`);
    setMessage(`${notes.join('／')}。`);
  }

  async function uploadOne(file: File) {
    const form = new FormData();
    form.set('file', file);
    const res = await fetch('/api/cloud-stock/upload', {
      method: 'POST',
      headers: { 'x-app-password': appPassword },
      body: form
    });
    return readJson(res);
  }

  async function uploadSelected() {
    if (!ready || uploading || syncing || processing || selectedFiles.length === 0) return;
    setUploading(true);
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    const failedFiles: File[] = [];
    setUploadProgress({ completed: 0, total: selectedFiles.length, failed: 0 });

    try {
      for (let index = 0; index < selectedFiles.length; index += UPLOAD_CONCURRENCY) {
        const chunk = selectedFiles.slice(index, index + UPLOAD_CONCURRENCY);
        const results = await Promise.all(chunk.map(async (file) => {
          try {
            await uploadOne(file);
            return { ok: true, file };
          } catch {
            return { ok: false, file };
          }
        }));

        for (const result of results) {
          completed += 1;
          if (result.ok) succeeded += 1;
          else {
            failed += 1;
            failedFiles.push(result.file);
          }
        }
        setUploadProgress({ completed, total: selectedFiles.length, failed });
        setMessage(`アップロード中：${completed}/${selectedFiles.length}件（成功 ${succeeded}／失敗 ${failed}）`);
      }

      const queues = await refreshQueues();
      setSelectedFiles(failedFiles);
      setMessage(
        `アップロード完了：成功 ${succeeded}件／失敗 ${failed}件` +
        (failed > 0
          ? '。失敗分だけ選択状態に残しています。再実行できます。'
          : `。未OCR ${queues.ocr.total}件／記事分割未実施 ${queues.organize.total}件（任意）`)
      );
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : 'アップロードに失敗しました。'));
    } finally {
      setUploading(false);
    }
  }

  async function syncDrive() {
    if (!ready || syncing || uploading || processing) return;
    setSyncing(true);
    setMessage('Googleドライブの資料を確認しています…');
    try {
      const res = await fetch('/api/cloud-stock/sync-drive', {
        method: 'POST',
        headers: { 'x-app-password': appPassword }
      });
      const json = await readJson(res);
      const queues = await refreshQueues();
      setMessage(`同期完了：新規 ${Number(json.newly_registered || 0)}件／未OCR ${queues.ocr.total}件／記事分割未実施 ${queues.organize.total}件（任意）`);
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : '同期に失敗しました。'));
    } finally {
      setSyncing(false);
    }
  }

  async function runBatch() {
    if (!ready || syncing || uploading || processing || pendingOcr === 0) return;
    setProcessing(true);
    try {
      const response = await fetch('/api/cloud-stock/background', {
        method: 'POST',
        headers: { 'x-app-password': appPassword }
      });
      const json = await readJson(response);
      await refreshQueues().catch(() => null);
      setMessage(String(json.message || 'バックグラウンドOCRを開始しました。アプリを閉じても処理は継続します。'));
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : 'バックグラウンドOCRを開始できませんでした。'));
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm font-bold text-emerald-700">資料を追加</p>
        <h1 className="mt-1 text-xl font-black">原本を追加して、GPTから検索できる状態にする</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          原本はGoogleドライブ「01 Originals」に保存し、Neonへ登録します。OCR完了時点でGPT検索可能です。記事単位へのAI分割は検索の前提ではなく、必要な場合だけ行う任意処理です。
        </p>

        <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
          <p className="text-sm font-bold text-zinc-800">アプリからまとめてアップロード</p>
          <p className="mt-1 text-xs leading-5 text-zinc-600">最大100件。JPG / PNG / WebP / PDF、1ファイル3.5MB以下。内部では3件ずつ並列送信します。</p>
          <input
            className="input mt-3"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf"
            disabled={!ready || uploading || syncing || processing}
            onChange={(event) => chooseUploadFiles(Array.from(event.target.files || []))}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="btn btn-primary min-h-11"
              type="button"
              disabled={!ready || uploading || syncing || processing || selectedFiles.length === 0}
              onClick={() => void uploadSelected()}
            >
              {uploading
                ? `アップロード中 ${uploadProgress.completed}/${uploadProgress.total}`
                : selectedFiles.length > 0
                  ? `選択した${selectedFiles.length}件をアップロード`
                  : 'ファイルを選択してください'}
            </button>
            <span className="text-sm text-zinc-600">選択中：{selectedFiles.length}/{MAX_UPLOAD_FILES}件</span>
            {selectedFiles.length > 0 && !uploading && (
              <button className="btn min-h-11" type="button" onClick={() => setSelectedFiles([])}>選択をクリア</button>
            )}
          </div>
          {uploading && uploadProgress.total > 0 && (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200">
              <div
                className="h-full bg-zinc-800 transition-all"
                style={{ width: `${Math.min(100, Math.round((uploadProgress.completed / uploadProgress.total) * 100))}%` }}
              />
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-3">
          <a className="btn flex min-h-12 items-center justify-center text-center" href={DRIVE_URL} target="_blank" rel="noreferrer">
            1. Googleドライブに原本を追加
          </a>
          <button className="btn min-h-12" type="button" onClick={syncDrive} disabled={!ready || syncing || uploading || processing}>
            {syncing ? '同期しています…' : '2. 追加した原本をMJに同期'}
          </button>
          <button className="btn min-h-12" type="button" onClick={() => void runBatch()} disabled={!ready || syncing || uploading || processing || pendingOcr === 0}>
            {processing
              ? 'バックグラウンドOCRを開始しています…'
              : pendingOcr > 0
                ? `3. OCRをバックグラウンド実行（${pendingOcr}件）`
                : '3. 未OCR資料なし'}
          </button>
          <Link className="btn min-h-12 flex items-center justify-center" href="/cloud-stock">
            整理済み記事一覧を見る
          </Link>
        </div>

        <div className="mt-3 rounded-xl bg-zinc-50 px-3 py-2 text-sm leading-6 text-zinc-700">
          <p className="font-semibold">{message}</p>
          {optionalOrganize > 0 && (
            <p className="mt-1 text-xs text-zinc-500">記事分割未実施 {optionalOrganize}件はエラーではありません。原本OCRはGPTから検索できます。</p>
          )}
        </div>
      </div>

      <div className="card p-5">
        <p className="text-sm font-bold text-zinc-500">保存と検索の役割</p>
        <div className="mt-3 space-y-2 text-sm leading-6 text-zinc-700">
          <p><strong>Googleドライブ：</strong>「01 Originals」を原本の正本として保持</p>
          <p><strong>Neon：</strong>OCR本文と検索索引を保持。OCR済み原本は記事分割前でも検索対象</p>
          <p><strong>ChatGPT：</strong>記事検索、原本確認、横断分析、BOOK分析観点の選択、レポート作成</p>
          <p><strong>記事分割：</strong>必要な紙面だけ後から実行する任意の高精度化処理</p>
        </div>
      </div>
    </div>
  );
}
