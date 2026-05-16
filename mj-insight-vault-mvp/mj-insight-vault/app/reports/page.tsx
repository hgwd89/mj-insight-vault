'use client';

import Link from 'next/link';
import { useApi } from '@/components/DataHooks';

type Report = {
  id: string;
  user_query: string;
  answer_text: string | null;
  answer_json: Record<string, unknown> | null;
  related_article_ids: string[] | null;
  created_at: string;
};

function shortText(value: string | null | undefined, max = 280) {
  const text = value || '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function reportTitle(report: Report) {
  const answer = report.answer_json || {};
  if (typeof answer.report_title === 'string' && answer.report_title.trim()) return answer.report_title;
  return report.user_query;
}

function isPinned(report: Report) {
  return Boolean(report.answer_json?.pinned);
}

export default function ReportsPage() {
  const { data, error, loading } = useApi<{ reports: Report[] }>('/api/reports');

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  const reports = [...(data?.reports || [])].sort((a, b) => {
    if (isPinned(a) && !isPinned(b)) return -1;
    if (!isPinned(a) && isPinned(b)) return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-black">分析履歴</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              保存された分析レポートです。ピン留めした重要レポートを上部に表示し、各レポートを開いて深掘りできます。
            </p>
          </div>
          <Link className="btn" href="/chat">新しく分析する</Link>
        </div>
      </div>

      {reports.length === 0 && (
        <div className="card p-5 text-sm text-zinc-500">分析履歴はありません。</div>
      )}

      {reports.map((report) => {
        const answer = report.answer_json || {};
        const targetScope = typeof answer.target_scope === 'string' ? answer.target_scope : '';
        const outputTemplate = typeof answer.output_template === 'string' ? answer.output_template : '';
        const modelUsed = typeof answer.model_used === 'string' ? answer.model_used : '';
        const parentReportId = typeof answer.parent_report_id === 'string' ? answer.parent_report_id : '';

        return (
          <Link key={report.id} href={`/reports/${report.id}`} className="card block p-4 hover:opacity-80">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {isPinned(report) && <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">Pinned</span>}
                {parentReportId && <span className="badge">深掘り</span>}
                <p className="text-xs text-zinc-500">{new Date(report.created_at).toLocaleString('ja-JP')}</p>
              </div>
              <h2 className="mt-2 font-bold">{reportTitle(report)}</h2>
              <p className="mt-1 text-sm text-zinc-500">元指示: {report.user_query}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {targetScope && <span className="badge">scope: {targetScope}</span>}
                {outputTemplate && <span className="badge">template: {outputTemplate}</span>}
                {modelUsed && <span className="badge">model: {modelUsed}</span>}
                <span className="badge">記事 {report.related_article_ids?.length || 0}</span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">{shortText(report.answer_text)}</p>
              <p className="mt-3 text-sm font-semibold text-zinc-900">開いて対話する →</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
