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

type LegacyArticleRow = {
  id: string;
  headline: string | null;
  article_date?: string | null;
  ocr_text: string | null;
  article_type?: string | null;
  created_at?: string | null;
  status?: string | null;
};

type LoadResult = {
  current: ArticleRow[];
  legacy: LegacyArticleRow[];
  legacyError: string;
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

function legacyPreview(value?: string | null) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 360);
}

export function NeonArticleVault() {
  const appPassword = useAppPassword();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ArticleRow[]>([]);
  const [legacyRows, setLegacyRows] = useState<LegacyArticleRow[]>([]);
  const [legacyError, setLegacyError] = useState('');
  const [message, setMessage] = useState('記事を読み込んでいます…');

  async function loadArticles(q = ''): Promise<LoadResult> {
    const trimmed = q.trim();
    const currentRequest = fetch(`/api/cloud-stock/articles?q=${encodeURIComponent(trimmed)}`, {
      headers: { 'x-app-password': appPassword },
      cache: 'no-store'
    }).then(readJson);

    const legacyRequest = fetch(`/api/articles${trimmed ? `?q=${encodeURIComponent(trimmed)}` : ''}`, {
      headers: { 'x-app-password': appPassword },
      cache: 'no-store'
    }).then(readJson);

    const [currentResult, legacyResult] = await Promise.allSettled([currentRequest, legacyRequest]);

    if (currentResult.status === 'rejected') throw currentResult.reason;

    const currentJson = currentResult.value;
    const current = Array.isArray(currentJson.rows) ? currentJson.rows as ArticleRow[] : [];
    const legacy = legacyResult.status === 'fulfilled' && Array.isArray(legacyResult.value.articles)
      ? (legacyResult.value.articles as LegacyArticleRow[]).filter((article) => article.status !== 'deleted')
      : [];
    const nextLegacyError = legacyResult.status === 'rejected'
      ? (legacyResult.reason instanceof Error ? legacyResult.reason.message : '過去記事を取得できませんでした。')
      : '';

    setRows(current);
    setLegacyRows(legacy);
    setLegacyError(nextLegacyError);
    return { current, legacy, legacyError: nextLegacyError };
  }

  function summaryText(result: LoadResult, searched: boolean) {
    const prefix = searched ? '検索結果' : '記事';
    const base = `${prefix} ${result.current.length + result.legacy.length}件（新規 ${result.current.length} / 過去 ${result.legacy.length}）`;
    return result.legacyError ? `${base} ※過去記事DBは現在取得失敗` : base;
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
        setMessage(summaryText(initial, false));
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
      setMessage(summaryText(result, Boolean(query.trim())));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '検索できませんでした。');
    } finally {
      setLoading(false);
    }
  }

  function rememberScroll() {
    sessionStorage.setItem('mj-article-scroll', String(window.scrollY));
  }

  const noRows = !loading && rows.length === 0 && legacyRows.length === 0;

  return (
    <div className="space-y-5">
      <section className="card p-5">
        <p className="text-sm font-bold text-emerald-700">記事一覧・検索</p>
        <h1 className="mt-1 text-xl font-black sm:text-2xl">新規記事と過去記事をまとめて読む</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          新規記事はGoogle Drive＋Neon、過去記事は旧記事DBを横断して同じ検索欄から探します。
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
        {legacyError && (
          <p className="mt-2 text-xs leading-5 text-amber-700">
            過去記事DBへの接続に失敗しています。新規記事は利用できますが、過去記事は旧DB接続が復旧するまで表示できません。
          </p>
        )}
      </section>

      {noRows ? (
        <div className="card p-6 text-center">
          <p className="font-bold text-zinc-800">該当する記事がありません。</p>
          <p className="mt-2 text-sm leading-6 text-zinc-500">検索語を変えるか、「資料追加」から新しい原本を追加してください。</p>
          <Link className="btn mt-4 inline-flex min-h-11 items-center justify-center" href="/upload">資料追加へ</Link>
        </div>
      ) : null}

      {rows.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3 px-1">
            <div>
              <p className="text-xs font-bold text-emerald-700">Google Drive＋Neon</p>
              <h2 className="text-lg font-black text-zinc-900">新規記事</h2>
            </div>
            <span className="text-sm font-bold text-zinc-500">{rows.length}件</span>
          </div>
          {rows.map((article) => (
            <Link
              key={article.id}
              href={`/cloud-stock/articles/${encodeURIComponent(article.id)}`}
              onClick={rememberScroll}
              className="card block p-4 transition hover:border-zinc-400 hover:shadow-sm sm:p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-black leading-7 text-zinc-900 sm:text-lg">{article.title}</h3>
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
      )}

      {legacyRows.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3 px-1">
            <div>
              <p className="text-xs font-bold text-sky-700">旧記事DB</p>
              <h2 className="text-lg font-black text-zinc-900">過去記事</h2>
            </div>
            <span className="text-sm font-bold text-zinc-500">{legacyRows.length}件</span>
          </div>
          {legacyRows.map((article) => (
            <Link
              key={`legacy-${article.id}`}
              href={`/articles/${encodeURIComponent(article.id)}`}
              onClick={rememberScroll}
              className="card block p-4 transition hover:border-zinc-400 hover:shadow-sm sm:p-5"
            >
              <h3 className="text-base font-black leading-7 text-zinc-900 sm:text-lg">{article.headline || '無題の記事'}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                <span className="rounded-full bg-sky-50 px-2 py-1 font-semibold text-sky-700">過去記事</span>
                <span>{formatDate(article.article_date)}</span>
                {article.article_type && <span>{article.article_type}</span>}
              </div>
              {legacyPreview(article.ocr_text) && (
                <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-600">{legacyPreview(article.ocr_text)}</p>
              )}
              <div className="mt-3 text-right text-xs font-bold text-zinc-700">過去記事を読む →</div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
