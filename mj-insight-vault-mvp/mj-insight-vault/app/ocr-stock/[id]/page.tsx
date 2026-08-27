'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type StockImage = {
  id: string;
  file_name: string;
  storage_path: string;
  mime_type?: string | null;
  ocr_status: string;
  ocr_text_raw?: string | null;
  error_message?: string | null;
  created_at: string;
};

type StockResponse = {
  mode: 'ocr_only';
  batch: {
    id: string;
    memo: string | null;
    image_count: number;
    status: string;
    created_at: string;
  };
  images: StockImage[];
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function OcrStockDetailPage() {
  const params = useParams<{ id: string }>();
  const password = useAppPassword();
  const { data, error, loading } = useApi<StockResponse>(`/api/ocr-stock/batches/${params.id}`);
  const [images, setImages] = useState<StockImage[]>([]);
  const [busyId, setBusyId] = useState('');
  const [processingAll, setProcessingAll] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (data?.images) setImages(data.images);
  }, [data]);

  const pending = useMemo(() => images.filter((image) => ['queued', 'failed'].includes(image.ocr_status)), [images]);
  const doneCount = useMemo(() => images.filter((image) => image.ocr_status === 'done').length, [images]);
  const totalChars = useMemo(() => images.reduce((sum, image) => sum + String(image.ocr_text_raw || '').length, 0), [images]);

  async function runOcr(image: StockImage) {
    setBusyId(image.id);
    setImages((current) => current.map((item) => item.id === image.id ? { ...item, ocr_status: 'processing', error_message: null } : item));
    try {
      const res = await fetch(`/api/source-images/${image.id}/ocr-only`, {
        method: 'POST',
        headers: { 'x-app-password': password }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'OCRに失敗しました');
      const text = String(json.ocr_text_raw || '');
      setImages((current) => current.map((item) => item.id === image.id ? {
        ...item,
        ocr_status: 'done',
        ocr_text_raw: text,
        error_message: null
      } : item));
      setMessage(`${image.file_name}: OCR完了 ${text.length.toLocaleString()}文字`);
      return true;
    } catch (ocrError) {
      const text = ocrError instanceof Error ? ocrError.message : 'OCRに失敗しました';
      setImages((current) => current.map((item) => item.id === image.id ? { ...item, ocr_status: 'failed', error_message: text } : item));
      setMessage(`${image.file_name}: ${text}`);
      return false;
    } finally {
      setBusyId('');
    }
  }

  async function runPendingSequentially() {
    if (!pending.length || processingAll) return;
    setProcessingAll(true);
    setMessage(`${pending.length}枚を1枚ずつOCRします。`);
    for (const image of pending) {
      const ok = await runOcr(image);
      if (!ok) break;
      await sleep(500);
    }
    setProcessingAll(false);
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;
  if (!data) return <div className="card p-5">データがありません。</div>;

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs text-zinc-500">{new Date(data.batch.created_at).toLocaleString('ja-JP')}</p>
            <h1 className="mt-1 text-xl font-black">OCRストック詳細</h1>
            <p className="mt-2 text-sm text-zinc-600">{data.batch.memo || 'メモなし'}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="badge">画像 {images.length}</span>
              <span className="badge">OCR完了 {doneCount}</span>
              <span className="badge">OCR待ち/失敗 {pending.length}</span>
              <span className="badge">本文 {totalChars.toLocaleString()}文字</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" type="button" onClick={runPendingSequentially} disabled={processingAll || Boolean(busyId) || pending.length === 0}>
              {processingAll ? '順番にOCR中' : `未処理を1枚ずつOCR (${pending.length})`}
            </button>
            <Link className="btn" href="/ocr-stock">一覧へ</Link>
          </div>
        </div>
        {message && <p className="mt-3 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">{message}</p>}
      </div>

      <div className="grid gap-4">
        {images.length === 0 && <div className="card p-5 text-sm text-zinc-500">画像がありません。</div>}
        {images.map((image, index) => {
          const text = String(image.ocr_text_raw || '');
          return (
            <section key={image.id} className="card p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="font-bold">{index + 1}. {image.file_name}</h2>
                  <div className="mt-2 flex gap-2 text-xs"><span className="badge">{image.ocr_status}</span>{text && <span className="badge">{text.length.toLocaleString()}文字</span>}</div>
                  {image.error_message && image.ocr_status === 'failed' && <p className="mt-2 text-sm text-red-600">{image.error_message}</p>}
                </div>
                <div className="flex gap-2">
                  {['queued', 'failed'].includes(image.ocr_status) && (
                    <button className="btn btn-primary" type="button" onClick={() => runOcr(image)} disabled={processingAll || Boolean(busyId)}>
                      {busyId === image.id ? 'OCR中' : 'OCR'}
                    </button>
                  )}
                  {text && <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(text)}>本文をコピー</button>}
                </div>
              </div>

              {text ? (
                <details className="mt-4" open>
                  <summary className="cursor-pointer text-sm font-bold">OCR本文</summary>
                  <pre className="mt-3 max-h-[34rem] overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-7 text-zinc-800">{text}</pre>
                </details>
              ) : (
                <p className="mt-4 text-sm text-zinc-500">OCR本文はまだありません。</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
