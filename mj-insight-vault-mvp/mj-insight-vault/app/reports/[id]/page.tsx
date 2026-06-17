'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { useApi } from '@/components/DataHooks';

type Report = {
  id: string;
  user_query: string;
  answer_text: string | null;
  answer_json: Record<string, unknown> | null;
  related_article_ids: string[] | null;
  created_at: string;
};

type Article = {
  id: string;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
};

function asText(value: unknown) {
  return value === undefined || value === null ? '' : String(value);
}

function formatTokyo(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function cutAtFirst(value: string, markers: string[]) {
  const indexes = markers.map((marker) => value.indexOf(marker)).filter((index) => index >= 0);
  return indexes.length ? value.slice(0, Math.min(...indexes)) : value;
}

function cleanDisplayText(value: unknown) {
  let text = asText(value);
  text = cutAtFirst(text, [
    '【レポート要件】',
    '[レポート要件]',
    'レポート要件',
    '最重要:',
    'coverage_diagnosis',
    'source_coverage',
    'explanatory_hypotheses',
    'hypothesis_comparison',
    'research_needs',
    'evidence_matrix',
    '必ず以下を出してください',
    '根拠記事IDのない重要主張は禁止'
  ]);
  return text
    .replace(/^\s*全記事を対象に、全データを広域スキャンしたうえで分析してください。[\s　]*/g, '')
    .replace(/^\s*MJ記事群から生活者動向を読み、説明仮説・根拠・調査が必要そうな論点を抽出します。[\s　]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getAnswer(report: Report) {
  const json = report.answer_json || {};
  const candidates = [json.answer_text, json.summary, report.answer_text];
  for (const candidate of candidates) {
    const cleaned = cleanDisplayText(candidate);
    if (cleaned) return cleaned;
  }
  return '表示できるレポート本文がありません。';
}

function getTitle(report: Report) {
  const json = report.answer_json || {};
  const title = cleanDisplayText(json.report_title);
  if (title) return title.replace(/\s+/g, ' ').trim();
  const query = cleanDisplayText(report.user_query).replace(/\s+/g, ' ').trim();
  return query || '分析レポート';
}

function getQuery(report: Report) {
  return cleanDisplayText(report.user_query).replace(/\s+/g, ' ').trim() || '分析指示未保存';
}

export default function ReportDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, error, loading } = useApi<{ report: Report; related_articles: Article[] }>(`/api/reports/${params.id}`);
  const report = data?.report;
  const articles = useMemo(() => data?.related_articles || [], [data?.related_articles]);

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;
  if (!report) return <div className="card p-5 text-red-600">レポートがありません</div>;

  const answer = getAnswer(report);
  const title = getTitle(report);
  const query = getQuery(report);

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs text-zinc-500">{formatTokyo(report.created_at)}</p>
            <h1 className="mt-2 text-xl font-black">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">指示: {query}</p>
          </div>
          <Link className="btn" href="/reports">分析履歴へ戻る</Link>
        </div>
      </div>

      <section className="card p-5">
        <h2 className="font-bold">分析レポート本文</h2>
        <div className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-7 text-zinc-700">{answer}</div>
      </section>

      <details className="card p-5">
        <summary className="cursor-pointer font-bold">レポート設定・元指示</summary>
        <p className="mt-4 rounded-xl bg-zinc-50 p-3 text-sm leading-7">{query}</p>
      </details>

      <section className="card p-5">
        <h2 className="font-bold">根拠記事</h2>
        <p className="mt-1 text-sm text-zinc-500">保存されている根拠記事リストです。</p>
        <div className="mt-3 grid gap-3">
          {articles.length === 0 && <p className="text-sm text-zinc-500">根拠記事は保存されていません。</p>}
          {articles.map((article) => (
            <div key={article.id} className="rounded-xl border border-zinc-200 p-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/articles/${article.id}`} className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900">{article.headline || '無題の記事'}</Link>
                    <span className="badge">{article.article_date || '日付不明'}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600">{article.ocr_text}</p>
                </div>
                <Link className="btn shrink-0" href={`/articles/${article.id}`}>記事詳細</Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
