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

export default function ReportsPage() {
  const { data, error, loading } = useApi<{ reports: Report[] }>('/api/reports');

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  const reports = data?.reports || [];

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-black">分析履歴</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              保存された分析レポートです。各レポートを開くと、結果について追加質問しながら分析を掘り下げられます。
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

        return (
          <Link key={report.id} href={`/reports/${report.id}`} className="card block p-4 hover:opacity-80">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-zinc-500">{new Date(report.created_at).toLocaleString('ja-JP')}</p>
              <h2 className="mt-1 font-bold">{report.user_query}</h2>
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
