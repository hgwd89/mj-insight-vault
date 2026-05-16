'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Article = {
  id: string;
  headline: string | null;
  ocr_text: string | null;
  article_type: string;
  created_at: string;
  status?: string | null;
};

export default function DeletedArticlesPage() {
  const password = useAppPassword();
  const { data, error, loading } = useApi<{ articles: Article[] }>('/api/articles?status=deleted');
  const [articles, setArticles] = useState<Article[]>([]);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    if (data?.articles) setArticles(data.articles);
  }, [data]);

  async function restoreArticle(articleId: string) {
    const ok = window.confirm('この記事を通常の記事一覧と分析対象に戻します。');
    if (!ok) return;

    setBusyId(articleId);

    try {
      const res = await fetch(`/api/articles/${articleId}?action=restore`, {
        method: 'DELETE',
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '復元に失敗しました');

      setArticles((prev) => prev.filter((a) => a.id !== articleId));
    } catch (error) {
      alert(error instanceof Error ? error.message : '復元に失敗しました');
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-black">不要記事一覧</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              不要記事にした記事を確認し、誤って消したものを復元できます。
            </p>
          </div>
          <Link className="btn" href="/articles">記事一覧へ戻る</Link>
        </div>
      </div>

      {loading && <div className="card p-5">読み込み中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}

      <div className="grid gap-3">
        {articles.length === 0 && !loading && !error && (
          <div className="card p-5 text-sm text-zinc-500">不要記事はありません。</div>
        )}

        {articles.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <p className="font-bold">{a.headline || '無題の記事候補'}</p>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600">{a.ocr_text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="badge">{a.article_type}</span>
                  <span className="badge">{a.status || 'deleted'}</span>
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                <Link className="btn" href={`/articles/${a.id}`}>詳細</Link>
                <button
                  className="btn btn-primary"
                  onClick={() => restoreArticle(a.id)}
                  disabled={busyId === a.id}
                >
                  {busyId === a.id ? '復元中' : '復元'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
