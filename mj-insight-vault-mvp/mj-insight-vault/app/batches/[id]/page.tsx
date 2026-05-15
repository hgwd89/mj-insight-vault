'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApi } from '@/components/DataHooks';

type Image = { id: string; file_name: string; storage_path: string; ocr_status: string; error_message?: string | null };
type Article = { id: string; headline: string | null; article_index: number; article_type: string; has_table: boolean; has_chart: boolean; status: string };

export default function BatchDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, error, loading } = useApi<{ batch: { id: string; memo: string | null; status: string; created_at: string }; images: Image[]; articles: Article[] }>(`/api/batches/${params.id}`);
  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;
  const batch = data!.batch;
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <p className="text-sm text-zinc-500">{new Date(batch.created_at).toLocaleString('ja-JP')}</p>
        <h1 className="mt-1 text-xl font-black">バッチ詳細</h1>
        <p className="mt-2 text-sm text-zinc-600">{batch.memo || 'メモなし'}</p>
        <div className="mt-3 flex gap-2"><span className="badge">状態 {batch.status}</span><span className="badge">画像 {data!.images.length}</span><span className="badge">記事候補 {data!.articles.length}</span></div>
      </div>
      <section className="card p-5">
        <h2 className="font-bold">記事候補</h2>
        <div className="mt-3 grid gap-3">
          {data!.articles.map((a) => (
            <Link key={a.id} href={`/articles/${a.id}`} className="rounded-xl border border-zinc-200 p-3 hover:bg-zinc-50">
              <p className="font-semibold">{a.headline || '無題の記事候補'}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs"><span className="badge">{a.article_type}</span>{a.has_table && <span className="badge">表</span>}{a.has_chart && <span className="badge">図表</span>}<span className="badge">{a.status}</span></div>
            </Link>
          ))}
        </div>
      </section>
      <section className="card p-5">
        <h2 className="font-bold">画像</h2>
        <div className="mt-3 grid gap-2">
          {data!.images.map((img) => <div key={img.id} className="rounded-xl border border-zinc-200 p-3 text-sm"><b>{img.file_name}</b> <span className="badge ml-2">{img.ocr_status}</span>{img.error_message && <p className="mt-1 text-red-600">{img.error_message}</p>}</div>)}
        </div>
      </section>
    </div>
  );
}
