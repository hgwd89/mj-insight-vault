'use client';

import Link from 'next/link';
import { useApi } from '@/components/DataHooks';

type Batch = { id: string; memo: string | null; image_count: number; status: string; created_at: string; source_images?: { count: number }[]; articles?: { count: number }[] };

export default function BatchesPage() {
  const { data, error, loading } = useApi<{ batches: Batch[] }>('/api/batches');
  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-black">バッチ一覧</h1>
      {(data?.batches || []).map((b) => (
        <Link key={b.id} href={`/batches/${b.id}`} className="card block p-4 hover:border-zinc-400">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-bold">{new Date(b.created_at).toLocaleString('ja-JP')}</p>
              <p className="mt-1 text-sm text-zinc-600">{b.memo || 'メモなし'}</p>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="badge">画像 {b.image_count}</span>
              <span className="badge">状態 {b.status}</span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
