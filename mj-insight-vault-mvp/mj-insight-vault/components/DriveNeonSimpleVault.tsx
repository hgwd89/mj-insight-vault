'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DRIVE_URL = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';
const PROCESS_CONCURRENCY = 2;

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

function sourceId(row: QueueRow) {
  return row.source_file_id || row.id || '';
}

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

export function DriveNeonSimpleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('接続を確認しています…');
  const [syncing, setSyncing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [pendingOcr, setPendingOcr] = useState(0);
  const [pendingOrganize, setPendingOrganize] = useState(0);
  const [progress, setProgress] = useState<Progress>({ completed: 0, total: 0, failed: 0 });

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

  async function loadPendingOrganize() {
    const res = await fetch('/api/cloud-stock/organize', {
      headers: { 'x-app-password': appPassword }
    });
    const json = await readJson(res);
    const rows = Array.isArray(json.rows) ? json.rows as QueueRow[] : [];
    const total = Number.isFinite(Number(json.total)) ? Math.max(0, Number(json.total)) : rows.length;
    setPendingOrganize(total);
    return { rows, total };
  }

  async function refreshQueues() {
    const [ocr, organize] = await Promise.all([loadPendingOcr(), loadPendingOrganize()]);
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
        setMessage(`未OCR ${queues.ocr.total}件／記事整理待ち ${queues.organize.total}件`);
      } catch (error) {
        setReady(false);
        setMessage(japaneseError(error instanceof Error ? error.message : '接続に失敗しました。'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  async function syncDrive() {
    if (!ready || syncing || processing) return;
    setSyncing(true);
    setMessage('Googleドライブの資料を確認しています…');
    try {
      const res = await fetch('/api/cloud-stock/sync-drive', {
        method: 'POST',
        headers: { 'x-app-password': appPassword }
      });
      const json = await readJson(res);
      const queues = await refreshQueues();
      setMessage(`同期完了：新規 ${Number(json.newly_registered || 0)}件／未OCR ${queues.ocr.total}件／記事整理待ち ${queues.organize.total}件`);
    } catch (error) {
      setMessage(japaneseError(error instanceof Error ? error.message : '同期に失敗しました。'));
    } finally {
      setSyncing(false);
    }
  }

  async function organizeOne(id: string) {
    const res = await fetch('/api/cloud-stock/organize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
      body: JSON.stringify({ source_file_id: id })
    });
    return readJson(res);
  }

  async function ocrAndOrganizeOne(id: string) {
    const ocrRes = await fetch('/api/cloud-stock/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
      body: JSON.stringify({ source_file_id: id })
    });
    await readJson(ocrRes);
    await organizeOne(id);
  }

  async function runBatch() {
    if (!ready || syncing || processing) return;
    setProcessing(true);
    let completed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const initial = await refreshQueues();
      const initialTotal = initial.ocr.total + initial.organize.total;
      setProgress({ completed: 0, total: initialTotal, failed: 0 });
      if (initialTotal === 0) {
        setMessage('処理待ちの資料はありません。');
        return;
      }

      const processRows = async (rows: QueueRow[], mode: 'ocr' | 'organize') => {
        for (let index = 0; index < rows.length; index += PROCESS_CONCURRENCY) {
          const chunk = rows.slice(index, index + PROCESS_CONCURRENCY);
          const results = await Promise.all(chunk.map(async (row) => {
            const id = sourceId(row);
            if (!id) return false;
            try {
              if (mode === 'ocr') await ocrAndOrganizeOne(id);
              else await organizeOne(id);
              return true;
            } catch {
              return false;
            }
          }));

          for (const ok of results) {
            completed += 1;
            if (ok) succeeded += 1;
            else failed += 1;
          }
          setProgress({ completed, total: initialTotal, failed });
          setMessage(`OCR・記事整理中：${completed}/${initialTotal}件（成功 ${succeeded}／失敗 ${failed}）`);
        }
      };

      await processRows(initial.ocr.rows, 'ocr');

      // OCR後に新たに記事整理待ちになったものは、上で連続処理済み。
      // 開始時点ですでにOCR済みだった資料だけをここで整理する。
      const initialOcrIds = new Set(initial.ocr.rows.map(sourceId).filter(Boolean));
      const organizeOnly = initial.organize.rows.filter((row) => !initialOcrIds.has(sourceId(row)));
      await processRows(organizeOnly, 'organize');

      const remaining = await refreshQueues();
      setMessage(
        `処理完了：成功 ${succeeded}件／失敗 ${failed}件` +
        (remaining.ocr.total + remaining.organize.total > 0
          ? `／再試行待ち ${remaining.ocr.total + remaining.organize.total}件`
          : '／すべて記事閲覧可能です。')
      );
    } catch (error) {
      await refreshQueues().catch(() => null);
      setMessage(japaneseError(error instanceof Error ? error.message : '一括処理に失敗しました。'));
    } finally {
      setProcessing(false);
    }
  }

  const pendingTotal = pendingOcr + pendingOrganize;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm font-bold text-emerald-700">資料を追加</p>
        <h1 className="mt-1 text-xl font-black">原本を追加して、記事として読める状態にする</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          原本はGoogleドライブの「01 Originals」に保存します。MJへ同期した後、一括処理するとOCRから記事分割・本文再構成まで続けて実行します。
        </p>

        <div className="mt-4 grid gap-3">
          <a className="btn btn-primary flex min-h-12 items-center justify-center text-center" href={DRIVE_URL} target="_blank" rel="noreferrer">
            1. Googleドライブに原本を追加
          </a>
          <button className="btn min-h-12" type="button" onClick={syncDrive} disabled={!ready || syncing || processing}>
            {syncing ? '同期しています…' : '2. 追加した原本をMJに同期'}
          </button>
          <button className="btn min-h-12" type="button" onClick={() => void runBatch()} disabled={!ready || syncing || processing || pendingTotal === 0}>
            {processing
              ? `処理中 ${progress.completed}/${progress.total}件`
              : pendingTotal > 0
                ? `3. OCR・記事整理を一括実行（${pendingTotal}件）`
                : '3. 未処理資料なし'}
          </button>
          <Link className="btn min-h-12 flex items-center justify-center" href="/cloud-stock">
            記事一覧を見る
          </Link>
        </div>

        {processing && progress.total > 0 && (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200">
            <div
              className="h-full bg-zinc-800 transition-all"
              style={{ width: `${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%` }}
            />
          </div>
        )}

        <p className="mt-3 text-sm font-semibold text-zinc-700">{message}</p>
      </div>

      <div className="card p-5">
        <p className="text-sm font-bold text-zinc-500">保存の役割</p>
        <div className="mt-3 space-y-2 text-sm leading-6 text-zinc-700">
          <p><strong>Googleドライブ：</strong>原本画像・PDFを保管</p>
          <p><strong>Neon：</strong>OCR本文、整理済み記事、検索データを保管</p>
          <p><strong>閲覧：</strong>原本ファイルではなく、整理済みの記事を「資料一覧・検索」から読みます。</p>
        </div>
      </div>
    </div>
  );
}
