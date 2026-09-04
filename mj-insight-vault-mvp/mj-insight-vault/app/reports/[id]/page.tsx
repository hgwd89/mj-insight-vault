'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { useApi } from '@/components/DataHooks';
import { MarkdownArticleText } from '@/components/MarkdownArticleText';

type Report = {
  id: string;
  user_query: string;
  answer_text: string | null;
  answer_json: Record<string, unknown> | null;
  related_article_ids: string[] | null;
  created_at: string;
  report_kind?: string | null;
  generation_status?: string | null;
  is_formal_report?: boolean | null;
  analysis_verification_status?: string | null;
  full_corpus_gate?: string | null;
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

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
    '\n\n【レポート要件】',
    '\r\n\r\n【レポート要件】',
    '\n\n[レポート要件]',
    '\r\n\r\n[レポート要件]'
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

function verification(report: Report) {
  const json = report.answer_json || {};
  const source = json.source_coverage && typeof json.source_coverage === 'object' && !Array.isArray(json.source_coverage)
    ? json.source_coverage as Record<string, unknown>
    : {};
  const integrityGate = asText(json.full_corpus_integrity_gate || source.full_corpus_integrity_gate || 'failed');
  const promptVersion = asText(json.full_corpus_prompt_version || source.full_corpus_prompt_version || '-');
  const representedBatches = asNumber(json.final_context_represented_batches || source.final_context_represented_batches);
  const representedArticles = asNumber(json.final_context_represented_article_count || source.final_context_represented_article_count);
  const omittedBatches = asNumber(json.final_context_omitted_batches || source.final_context_omitted_batches);
  const analyzedArticles = asNumber(source.full_corpus_analyzed_article_count || json.full_corpus_analyzed_article_count);
  const snapshotPass = promptVersion === 'neon_report_aaaa_v3_snapshot'
    && integrityGate === 'neon_native_full_corpus_snapshot'
    && analyzedArticles > 0
    && representedArticles === analyzedArticles
    && representedBatches > 0
    && omittedBatches === 0;
  const storedCountGate = asText(report.full_corpus_gate || json.full_corpus_gate || source.full_corpus_gate);

  return {
    formal: report.is_formal_report === true || snapshotPass,
    kind: asText(report.report_kind || json.report_kind || 'provisional'),
    verificationStatus: asText(report.analysis_verification_status || json.analysis_verification_status || 'unverified'),
    countGate: snapshotPass ? 'passed' : (storedCountGate || 'failed'),
    integrityGate,
    promptVersion,
    representedBatches,
    representedArticles,
    omittedBatches,
    analyzedArticles
  };
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
  const status = verification(report);

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-zinc-500">{formatTokyo(report.created_at)}</p>
              <span className={status.formal ? 'rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800' : 'rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800'}>
                {status.formal ? '正式・全件検証済み' : '暫定・未検証'}
              </span>
              <span className="badge">{status.verificationStatus}</span>
            </div>
            <h1 className="mt-2 text-xl font-black">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">指示: {query}</p>
          </div>
          <Link className="btn" href="/reports">分析履歴へ戻る</Link>
        </div>
      </div>

      {!status.formal && (
        <section className="card border-amber-300 bg-amber-50 p-5">
          <h2 className="font-bold text-amber-900">このレポートは正式レポートではありません</h2>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            正式扱いには、対象記事の固定スナップショット全件読解、全バッチ統合、省略0、件数一致、整合性ゲート通過が必要です。
          </p>
        </section>
      )}

      <section className="card p-5">
        <h2 className="font-bold">検証状態</h2>
        <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <p>種別: <strong>{status.kind}</strong></p>
          <p>件数ゲート: <strong>{status.countGate}</strong></p>
          <p>整合性ゲート: <strong>{status.integrityGate}</strong></p>
          <p>スキャン版: <strong>{status.promptVersion}</strong></p>
          <p>最終統合バッチ: <strong>{status.representedBatches}</strong></p>
          <p>省略バッチ: <strong>{status.omittedBatches}</strong></p>
          <p>最終統合記事: <strong>{status.representedArticles}</strong></p>
          <p>本文読解記事: <strong>{status.analyzedArticles}</strong></p>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-bold">分析レポート本文</h2>
        <MarkdownArticleText text={answer} articles={articles} className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-7 text-zinc-700" />
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
