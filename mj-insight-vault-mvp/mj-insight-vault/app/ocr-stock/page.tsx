'use client';

import Link from 'next/link';
import { useApi } from '@/components/DataHooks';

type Batch = {
  id: string;
  memo: string | null;
  image_count: number;
  status: string;
  created_at: string;
};

type ResponseBody = { batches: Batch[] };

export default function OcrStockPage() {
  const { data, error, loading } = useApi<ResponseBody>('/api/batches');

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  const batches = data?.batches || [];

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h1 className="text-xl font-black">OCRストック</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          保存済み画像とOCR本文だけを確認します。この画面から記事化・分類・分析は実行しません。
        </p>
        <div className="mt-4"><Link className="btn btn-primary" href="/upload">画像を追加</Link></div>
      </div>

      <div className="card p-5">
        <h2 className="font-bold">保存履歴</h2>
        <div className="mt-3 grid gap-3">
          {batches.length === 0 && <p className="text-sm text-zinc-500">保存履歴がありません。</p>}
          {batches.map((batch) => (
            <Link key={batch.id} href={`/ocr-stock/${batch.id}`} className="rounded-xl border border-zinc-200 p-4 hover:bg-zinc-50">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <b>{batch.memo || 'メモなし'}</b>
                  <p className="mt-1 text-xs text-zinc-500">{new Date(batch.created_at).toLocaleString('ja-JP')}</p>
                </div>
                <div className="flex gap-2 text-xs"><span className="badge">画像 {batch.image_count || 0}</span><span className="badge">{batch.status}</span></div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
