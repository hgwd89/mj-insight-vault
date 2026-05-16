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
  has_table: boolean;
  has_chart: boolean;
  created_at: string;
  status?: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};

export default function ArticlesPage() {
  const password = useAppPassword();
  const [q, setQ] = useState('');

  const { data, error, loading } = useApi<{ articles: Article[] }>(
    `/api/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`
  );

  const [articles, setArticles] = useState<Article[]>([]);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    if (data?.articles) {
      setArticles(data.articles.filter((a) => a.status !== 'deleted'));
    }
  }, [data]);

  async function deleteArticle(articleId: string) {
    const ok = window.confirm(
      'この記事を不要記事にします。物理削除ではなく status=deleted にして、一覧・分析対象から外します。'
    );

    if (!ok) return;

    setBusyId(articleId);

    try {
      const res = await fetch(`/api/articles/${articleId}`, {
        method: 'DELETE',
        headers: {
          'x-app-password': password
        }
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || '削除に失敗しました');
      }

      setArticles((prev) => prev.filter((a) => a.id !== articleId));
    } catch (error) {
      alert(error instanceof Error ? error.message : '削除に失敗しました');
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">記事一覧</h1>

        <input
          className="input mt-4"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="見出し・本文検索"
        />
      </div>

      {loading && <div className="card p-5">読み込み中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}

      <div className="grid gap-3">
        {articles.length === 0 && !loading && !error && (
          <div className="card p-5 text-sm text-zinc-500">
            表示できる記事がありません。
          </div>
        )}

        {articles.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <Link
                href={`/articles/${a.id}`}
                className="min-w-0 flex-1 hover:opacity-80"
              >
                <p className="font-bold">
                  {a.headline || '無題の記事候補'}
                </p>

                <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600">
                  {a.ocr_text}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="badge">{a.article_type}</span>
                  {a.has_table && <span className="badge">表</span>}
                  {a.has_chart && <span className="badge">図表</span>}
                  {(a.article_tags || []).map((t) => (
                    <span key={`${t.tag_type}-${t.tag_name}`} className="badge">
                      {t.tag_name}
                    </span>
                  ))}
                </div>
              </Link>

              <button
                className="btn shrink-0 border-red-300 text-red-600 hover:bg-red-50"
                onClick={() => deleteArticle(a.id)}
                disabled={busyId === a.id}
              >
                {busyId === a.id ? '処理中' : '不要記事'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
