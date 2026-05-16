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
              Chatで実行した分析結果を新しい順に表示します。
            </p>
          </div>
          <Link className="btn" href="/chat">Chatへ戻る</Link>
        </div>
      </div>

      {reports.length === 0 && (
        <div className="card p-5 text-sm text-zinc-500">分析履歴はありません。</div>
      )}

      {reports.map((report) => {
        const answer = report.answer_json || {};
        const analysisMode = typeof answer.analysis_mode === 'string' ? answer.analysis_mode : '';
        const targetScope = typeof answer.target_scope === 'string' ? answer.target_scope : '';
        const outputTemplate = typeof answer.output_template === 'string' ? answer.output_template : '';
        const modelUsed = typeof answer.model_used === 'string' ? answer.model_used : '';

        return (
          <div key={report.id} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-zinc-500">{new Date(report.created_at).toLocaleString('ja-JP')}</p>
                <h2 className="mt-1 font-bold">{report.user_query}</h2>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {analysisMode && <span className="badge">mode: {analysisMode}</span>}
                  {targetScope && <span className="badge">scope: {targetScope}</span>}
                  {outputTemplate && <span className="badge">template: {outputTemplate}</span>}
                  {modelUsed && <span className="badge">model: {modelUsed}</span>}
                  <span className="badge">記事 {report.related_article_ids?.length || 0}</span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">{shortText(report.answer_text)}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
