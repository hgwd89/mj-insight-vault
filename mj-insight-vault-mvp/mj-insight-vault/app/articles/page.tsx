'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Article = {
  id: string;
  headline: string | null;
  article_date?: string | null;
  ocr_text: string | null;
  article_type: string;
  has_table: boolean;
  has_chart: boolean;
  created_at: string;
  status?: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};

type FilterKind = 'all' | 'duplicate' | 'date_unknown' | 'needs_review' | 'has_table_chart';

const deleteReasons = ['重複', 'OCR崩れ', '広告', '対象外', '誤抽出', 'その他'];

function duplicateKey(article: Article) {
  const base = `${article.headline || ''} ${(article.ocr_text || '').slice(0, 500)}`
    .replace(/[\s\n\r\t　、。・「」『』（）()【】\[\]{}]/g, '')
    .toLowerCase();

  return base.slice(0, 160);
}

function isDateUnknown(article: Article) {
  return !article.article_date || article.article_date === '日付不明';
}

export default function ArticlesPage() {
  const password = useAppPassword();
  const [q, setQ] = useState('');
  const [filterKind, setFilterKind] = useState<FilterKind>('all');

  const { data, error, loading } = useApi<{ articles: Article[] }>(
    `/api/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`
  );

  const [articles, setArticles] = useState<Article[]>([]);
  const [busyId, setBusyId] = useState('');
  const [reasonById, setReasonById] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data?.articles) {
      setArticles(data.articles.filter((a) => a.status !== 'deleted'));
    }
  }, [data]);

  const duplicateIds = useMemo(() => {
    const groups = new Map<string, string[]>();

    for (const article of articles) {
      const key = duplicateKey(article);
      if (key.length < 40) continue;
      groups.set(key, [...(groups.get(key) || []), article.id]);
    }

    const ids = new Set<string>();
    for (const group of groups.values()) {
      if (group.length > 1) group.forEach((id) => ids.add(id));
    }

    return ids;
  }, [articles]);

  const visibleArticles = useMemo(() => {
    return articles.filter((article) => {
      if (filterKind === 'duplicate') return duplicateIds.has(article.id);
      if (filterKind === 'date_unknown') return isDateUnknown(article);
      if (filterKind === 'needs_review') return article.status === 'needs_review';
      if (filterKind === 'has_table_chart') return article.has_table || article.has_chart;
      return true;
    });
  }, [articles, duplicateIds, filterKind]);

  async function deleteArticle(articleId: string) {
    const reason = reasonById[articleId] || '重複';
    const ok = window.confirm(
      `この記事を不要記事にします。理由: ${reason}\n物理削除ではなく status=deleted にして、一覧・分析対象から外します。`
    );

    if (!ok) return;

    setBusyId(articleId);

    try {
      const res = await fetch(`/api/articles/${articleId}?reason=${encodeURIComponent(reason)}`, {
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
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-black">記事一覧</h1>
            <p className="mt-2 text-sm text-zinc-600">重複・ノイズ記事は「不要記事」で分析対象から外せます。日付不明や図表ありの記事も絞り込めます。</p>
          </div>
          <Link className="btn" href="/articles/deleted">不要記事一覧</Link>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_220px]">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="見出し・本文検索"
          />

          <select className="input" value={filterKind} onChange={(e) => setFilterKind(e.target.value as FilterKind)}>
            <option value="all">すべて</option>
            <option value="duplicate">重複候補</option>
            <option value="date_unknown">日付不明</option>
            <option value="needs_review">要確認</option>
            <option value="has_table_chart">表・図表あり</option>
          </select>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-600">
          <span className="badge">表示 {visibleArticles.length}</span>
          <span className="badge">全体 {articles.length}</span>
          <span className="badge">重複候補 {duplicateIds.size}</span>
          <span className="badge">日付不明 {articles.filter(isDateUnknown).length}</span>
        </div>
      </div>

      {loading && <div className="card p-5">読み込み中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}

      <div className="grid gap-3">
        {visibleArticles.length === 0 && !loading && !error && (
          <div className="card p-5 text-sm text-zinc-500">
            表示できる記事がありません。
          </div>
        )}

        {visibleArticles.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <Link
                href={`/articles/${a.id}`}
                className="min-w-0 flex-1 hover:opacity-80"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-bold">
                    {a.headline || '無題の記事候補'}
                  </p>
                  <span className="badge">{a.article_date || '日付不明'}</span>
                  {duplicateIds.has(a.id) && (
                    <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">重複候補</span>
                  )}
                </div>

                <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600">
                  {a.ocr_text}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="badge">{a.article_type}</span>
                  <span className="badge">{a.status || 'ocr_done'}</span>
                  {a.has_table && <span className="badge">表</span>}
                  {a.has_chart && <span className="badge">図表</span>}
                  {(a.article_tags || []).map((t) => (
                    <span key={`${t.tag_type}-${t.tag_name}`} className="badge">
                      {t.tag_name}
                    </span>
                  ))}
                </div>
              </Link>

              <div className="flex shrink-0 flex-col gap-2 md:w-40">
                <select
                  className="input text-sm"
                  value={reasonById[a.id] || '重複'}
                  onChange={(e) => setReasonById((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  disabled={busyId === a.id}
                >
                  {deleteReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                </select>
                <button
                  className="btn border-red-300 text-red-600 hover:bg-red-50"
                  onClick={() => deleteArticle(a.id)}
                  disabled={busyId === a.id}
                >
                  {busyId === a.id ? '処理中' : '不要記事'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
