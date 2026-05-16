'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Image = {
  id: string;
  file_name: string;
  storage_path: string;
  ocr_status: string;
  error_message?: string | null;
};

type Article = {
  id: string;
  source_image_id?: string | null;
  headline: string | null;
  article_index: number;
  article_type: string;
  has_table: boolean;
  has_chart: boolean;
  status: string;
};

type BatchResponse = {
  batch: {
    id: string;
    memo: string | null;
    status: string;
    created_at: string;
  };
  images: Image[];
  articles: Article[];
};

export default function BatchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const password = useAppPassword();

  const { data, error, loading } = useApi<BatchResponse>(`/api/batches/${params.id}`);
  const [articles, setArticles] = useState<Article[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [busyId, setBusyId] = useState('');
  const [imageBusyId, setImageBusyId] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [processingAll, setProcessingAll] = useState(false);
  const [processLog, setProcessLog] = useState('');

  useEffect(() => {
    if (data?.articles) {
      setArticles(data.articles.filter((a) => a.status !== 'deleted'));
    }
    if (data?.images) {
      setImages(data.images.filter((img) => img.ocr_status !== 'deleted'));
    }
  }, [data]);

  const counts = useMemo(() => {
    return images.reduce<Record<string, number>>((acc, img) => {
      acc[img.ocr_status] = (acc[img.ocr_status] || 0) + 1;
      return acc;
    }, {});
  }, [images]);

  const pendingImages = useMemo(
    () => images.filter((img) => ['queued', 'failed'].includes(img.ocr_status)),
    [images]
  );

  function extractFallbackDate(image: Image) {
    const match = (image.error_message || '').match(/article_date=([^;]+)/);
    return match?.[1]?.trim() || '';
  }

  async function deleteArticle(articleId: string) {
    const ok = window.confirm(
      'この記事を不要記事にします。物理削除ではなく status=deleted にして、分析対象から外します。'
    );

    if (!ok) return;

    setBusyId(articleId);

    try {
      const res = await fetch(`/api/articles/${articleId}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '削除に失敗しました');

      setArticles((prev) => prev.filter((a) => a.id !== articleId));
    } catch (error) {
      alert(error instanceof Error ? error.message : '削除に失敗しました');
    } finally {
      setBusyId('');
    }
  }

  async function processImage(image: Image) {
    setImageBusyId(image.id);
    setProcessLog(`${image.file_name} を処理中`);
    setImages((prev) => prev.map((img) => img.id === image.id ? { ...img, ocr_status: 'processing', error_message: null } : img));

    try {
      const res = await fetch(`/api/source-images/${image.id}/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ article_date: extractFallbackDate(image) })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'OCR処理に失敗しました');

      setImages((prev) => prev.map((img) => img.id === image.id ? { ...img, ocr_status: 'done', error_message: null } : img));
      setArticles((prev) => [...prev, ...(json.articles || [])]);
      setProcessLog(`${image.file_name}: 記事候補 ${json.article_count || 0} 件`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OCR処理に失敗しました';
      setImages((prev) => prev.map((img) => img.id === image.id ? { ...img, ocr_status: 'failed', error_message: message } : img));
      setProcessLog(`${image.file_name}: ${message}`);
    } finally {
      setImageBusyId('');
    }
  }

  async function processPendingImages() {
    if (!pendingImages.length) return;

    const ok = window.confirm(`${pendingImages.length}枚の未処理・失敗画像を順番にOCRします。`);
    if (!ok) return;

    setProcessingAll(true);

    for (const image of pendingImages) {
      await processImage(image);
    }

    setProcessingAll(false);
    setProcessLog('未処理画像の処理が完了しました。');
  }

  async function deleteImage(imageId: string) {
    const ok = window.confirm(
      'この画像を削除します。Storage上の画像を削除し、この画像から作った記事候補も不要記事化します。'
    );

    if (!ok) return;

    setImageBusyId(imageId);

    try {
      const res = await fetch(`/api/images/${imageId}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '画像削除に失敗しました');

      setImages((prev) => prev.filter((img) => img.id !== imageId));
      setArticles((prev) => prev.filter((article) => article.source_image_id !== imageId));
    } catch (error) {
      alert(error instanceof Error ? error.message : '画像削除に失敗しました');
    } finally {
      setImageBusyId('');
    }
  }

  async function deleteBatch() {
    const ok = window.confirm(
      'このアップロード履歴を不要にします。含まれる記事も一覧・分析対象から外します。元画像ファイルはStorageに残します。'
    );

    if (!ok) return;

    setBatchBusy(true);

    try {
      const res = await fetch(`/api/batches/${params.id}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'アップロード履歴の削除に失敗しました');

      router.push('/batches');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'アップロード履歴の削除に失敗しました');
    } finally {
      setBatchBusy(false);
    }
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  const batch = data!.batch;

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm text-zinc-500">
              {new Date(batch.created_at).toLocaleString('ja-JP')}
            </p>

            <h1 className="mt-1 text-xl font-black">アップロード詳細</h1>

            <p className="mt-2 text-sm text-zinc-600">
              {batch.memo || 'メモなし'}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <span className="badge">状態 {batch.status}</span>
              <span className="badge">画像 {images.length}</span>
              <span className="badge">処理待ち {counts.queued || 0}</span>
              <span className="badge">処理中 {counts.processing || 0}</span>
              <span className="badge">成功 {counts.done || 0}</span>
              <span className="badge">失敗 {counts.failed || 0}</span>
              <span className="badge">記事候補 {articles.length}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-2">
            <button
              className="btn btn-primary"
              onClick={processPendingImages}
              disabled={processingAll || imageBusyId !== '' || pendingImages.length === 0}
            >
              {processingAll ? '順番に処理中' : `未処理画像を順番にOCR (${pendingImages.length})`}
            </button>
            <button
              className="btn border-red-300 text-red-600 hover:bg-red-50"
              onClick={deleteBatch}
              disabled={batchBusy || processingAll}
            >
              {batchBusy ? '処理中' : 'アップロード履歴を不要化'}
            </button>
          </div>
        </div>
        {processLog && <p className="mt-3 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">{processLog}</p>}
      </div>

      <section className="card p-5">
        <h2 className="font-bold">記事候補</h2>

        <div className="mt-3 grid gap-3">
          {articles.length === 0 && (
            <p className="text-sm text-zinc-500">
              表示できる記事候補がありません。未処理画像をOCRしてください。
            </p>
          )}

          {articles.map((a) => (
            <div key={a.id} className="rounded-xl border border-zinc-200 p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="font-semibold">{a.headline || '無題の記事候補'}</p>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="badge">{a.article_type}</span>
                    {a.has_table && <span className="badge">表</span>}
                    {a.has_chart && <span className="badge">図表</span>}
                    <span className="badge">{a.status}</span>
                  </div>
                </div>

                <div className="flex shrink-0 gap-2">
                  <Link className="btn" href={`/articles/${a.id}`}>詳細</Link>

                  <button
                    className="btn border-red-300 text-red-600 hover:bg-red-50"
                    onClick={() => deleteArticle(a.id)}
                    disabled={busyId === a.id || processingAll}
                  >
                    {busyId === a.id ? '処理中' : '不要記事'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-bold">アップロード画像</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          画像は1枚ずつOCRできます。失敗した画像だけ再処理できます。画像を削除すると、その画像から作られた記事候補も不要記事になります。
        </p>

        <div className="mt-3 grid gap-2">
          {images.length === 0 && <p className="text-sm text-zinc-500">表示できる画像がありません。</p>}

          {images.map((img) => (
            <div key={img.id} className="rounded-xl border border-zinc-200 p-3 text-sm">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <b>{img.file_name}</b>
                  <span className="badge ml-2">{img.ocr_status}</span>
                  {img.error_message && img.ocr_status !== 'queued' && <p className="mt-1 text-red-600">{img.error_message}</p>}
                </div>

                <div className="flex shrink-0 gap-2">
                  {['queued', 'failed'].includes(img.ocr_status) && (
                    <button
                      className="btn btn-primary"
                      onClick={() => processImage(img)}
                      disabled={Boolean(imageBusyId) || processingAll}
                    >
                      {imageBusyId === img.id ? 'OCR中' : 'OCR'}
                    </button>
                  )}
                  <button
                    className="btn border-red-300 text-red-600 hover:bg-red-50"
                    onClick={() => deleteImage(img.id)}
                    disabled={imageBusyId === img.id || processingAll}
                  >
                    {imageBusyId === img.id ? '処理中' : '画像削除'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
