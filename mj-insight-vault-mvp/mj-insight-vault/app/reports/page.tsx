'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

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
  const password = useAppPassword();
  const { data, error, loading } = useApi<{ reports: Report[] }>('/api/reports');
  const [reports, setReports] = useState<Report[]>([]);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    setReports(data?.reports || []);
  }, [data]);

  async function hideReport(reportId: string) {
    const ok = window.confirm('この分析レポートを一覧から削除します。元記事や画像は削除されません。');
    if (!ok) return;

    setBusyId(reportId);
    try {
      const res = await fetch(`/api/reports/${reportId}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'レポート削除に失敗しました');
      setReports((prev) => prev.filter((report) => report.id !== reportId));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'レポート削除に失敗しました');
    } finally {
      setBusyId('');
    }
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  const sortedReports = [...reports].sort((a, b) => {
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
              保存された分析レポートです。重要レポートはピン留めし、不要なレポートは削除できます。
            </p>
          </div>
          <Link className="btn" href="/chat">新しく分析する</Link>
        </div>
      </div>

      {sortedReports.length === 0 && (
        <div className="card p-5 text-sm text-zinc-500">分析履歴はありません。</div>
      )}

      {sortedReports.map((report) => {
        const answer = report.answer_json || {};
        const targetScope = typeof answer.target_scope === 'string' ? answer.target_scope : '';
        const outputTemplate = typeof answer.output_template === 'string' ? answer.output_template : '';
        const modelUsed = typeof answer.model_used === 'string' ? answer.model_used : '';
        const parentReportId = typeof answer.parent_report_id === 'string' ? answer.parent_report_id : '';

        return (
          <div key={report.id} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <Link href={`/reports/${report.id}`} className="min-w-0 flex-1 hover:opacity-80">
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
              </Link>

              <button
                className="btn shrink-0 border-red-300 text-red-600 hover:bg-red-50"
                onClick={() => hideReport(report.id)}
                disabled={busyId === report.id}
              >
                {busyId === report.id ? '削除中' : '削除'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
