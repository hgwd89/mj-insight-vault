'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { useAppPassword } from '@/components/PasswordGate';

type ArticleRow = {
  id: string;
  source_file_id: string;
  article_sequence: number;
  title: string;
  preview?: string | null;
  article_date?: string | null;
  source_file_name?: string | null;
  verification_status?: string | null;
  updated_at?: string | null;
};

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`));
  return json;
}

function formatDate(value?: string | null) {
  if (!value) return '日付未設定';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

export function NeonArticleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ArticleRow[]>([]);
  const [message, setMessage] = useState('記事を読み込んでいます…');

  async function loadArticles(q = '') {
    const res = await fetch(`/api/cloud-stock/articles?q=${encodeURIComponent(q.trim())}`, {
      headers: { 'x-app-password': appPassword },
      cache: 'no-store'
    });
    const json = await readJson(res);
    const next = Array.isArray(json.rows) ? json.rows as ArticleRow[] : [];
    setRows(next);
    return next;
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
        const initial = await loadArticles('');
        setReady(true);
        setMessage(`記事 ${initial.length}件`);
        window.requestAnimationFrame(() => {
          const saved = Number(sessionStorage.getItem('mj-article-scroll') || '0');
          if (saved > 0) window.scrollTo({ top: saved, behavior: 'instant' as ScrollBehavior });
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '記事を取得できませんでした。');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPassword]);

  async function search() {
    if (!ready) return;
    setLoading(true);
    try {
      const result = await loadArticles(query);
      setMessage(query.trim() ? `検索結果 ${result.length}件` : `記事 ${result.length}件`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '検索できませんでした。');
    } finally {
      setLoading(false);
    }
  }

  function rememberScroll() {
    sessionStorage.setItem('mj-article-scroll', String(window.scrollY));
  }

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <p className="text-sm font-bold text-emerald-700">記事一覧・検索</p>
        <h1 className="mt-1 text-xl font-black sm:text-2xl">Google Drive＋Neonの記事を読む</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Neonに保存済みの記事を、見出し・本文・原本ファイル名から検索します。Supabaseは使用しません。
        </p>

        <div className="mt-4 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              className="input w-full pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
              placeholder="見出し・本文・ファイル名を検索"
            />
          </div>
          <button className="btn shrink-0" type="button" onClick={() => void search()} disabled={!ready || loading}>検索</button>
        </div>
        <p className="mt-3 text-sm font-semibold text-zinc-600">{message}</p>
      </section>

      <section className="space-y-3">
        {!loading && rows.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="font-bold text-zinc-800">該当する記事がありません。</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">検索語を変えるか、「資料追加」から新しい原本を追加してください。</p>
            <Link className="btn mt-4 inline-flex min-h-11 items-center justify-center" href="/upload">資料追加へ</Link>
          </div>
        ) : rows.map((article) => (
          <Link
            key={article.id}
            href={`/cloud-stock/articles/${encodeURIComponent(article.id)}`}
            onClick={rememberScroll}
            className="card block p-4 transition hover:border-zinc-400 hover:shadow-sm sm:p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-black leading-7 text-zinc-900 sm:text-lg">{article.title}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                  <span className="rounded-full bg-zinc-100 px-2 py-1 font-semibold">{formatDate(article.article_date)}</span>
                  {article.source_file_name && <span className="truncate">{article.source_file_name}</span>}
                </div>
              </div>
            </div>

            {article.preview && (
              <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-600">{article.preview}</p>
            )}

            <div className="mt-3 text-right text-xs font-bold text-zinc-700">記事・原本を読む →</div>
          </Link>
        ))}
      </section>
    </div>
  );
}
