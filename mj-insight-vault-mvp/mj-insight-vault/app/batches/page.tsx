'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Batch = {
  id: string;
  memo: string | null;
  image_count: number;
  status: string;
  created_at: string;
};

export default function BatchesPage() {
  const password = useAppPassword();
  const { data, error, loading } = useApi<{ batches: Batch[] }>('/api/batches');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    if (data?.batches) setBatches(data.batches.filter((b) => b.status !== 'deleted'));
  }, [data]);

  async function deleteBatch(batchId: string) {
    const ok = window.confirm(
      'このアップロード履歴を不要化します。中の記事も分析対象から外します。元画像ファイルはStorageに残します。'
    );

    if (!ok) return;

    setBusyId(batchId);

    try {
      const res = await fetch(`/api/batches/${batchId}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'アップロード履歴の不要化に失敗しました');

      setBatches((prev) => prev.filter((b) => b.id !== batchId));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'アップロード履歴の不要化に失敗しました');
    } finally {
      setBusyId('');
    }
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-black">アップロード履歴</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              1回のアップロード単位です。通常運用は「記事一覧」を見れば十分です。失敗画像や重複アップロードの整理が必要な時だけ使います。
            </p>
          </div>
          <Link className="btn" href="/articles">記事一覧へ</Link>
        </div>
      </div>

      {batches.length === 0 && (
        <div className="card p-5 text-sm text-zinc-500">表示できるアップロード履歴がありません。</div>
      )}

      {batches.map((b) => (
        <div key={b.id} className="card p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <Link href={`/batches/${b.id}`} className="min-w-0 flex-1 hover:opacity-80">
              <p className="font-bold">{new Date(b.created_at).toLocaleString('ja-JP')}</p>
              <p className="mt-1 text-sm text-zinc-600">{b.memo || 'メモなし'}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="badge">画像 {b.image_count}</span>
                <span className="badge">状態 {b.status}</span>
              </div>
            </Link>

            <button
              className="btn shrink-0 border-red-300 text-red-600 hover:bg-red-50"
              onClick={() => deleteBatch(b.id)}
              disabled={busyId === b.id}
            >
              {busyId === b.id ? '処理中' : '履歴を不要化'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
