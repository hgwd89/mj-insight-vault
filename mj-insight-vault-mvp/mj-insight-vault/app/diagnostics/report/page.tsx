'use client';

import { useApi } from '@/components/DataHooks';

type Check = {
  key: string;
  passed: boolean;
  actual: unknown;
  expected: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
};

type Diagnostics = {
  status: string;
  score: number;
  critical_failed: string[];
  high_failed: string[];
  checks: Check[];
  summary: string;
  report: null | {
    id: string;
    created_at: string;
    user_query: string;
    answer_head: string;
    source_coverage: Record<string, unknown>;
    quality_gate: Record<string, unknown>;
  };
};

function statusLabel(status: string) {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  if (status === 'needs_review') return '要確認';
  return status || '-';
}

function severityClass(severity: string, passed: boolean) {
  if (passed) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (severity === 'critical') return 'border-red-300 bg-red-50 text-red-700';
  if (severity === 'high') return 'border-amber-300 bg-amber-50 text-amber-700';
  return 'border-zinc-200 bg-zinc-50 text-zinc-700';
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export default function ReportDiagnosticsPage() {
  const { data, error, loading } = useApi<Diagnostics>('/api/diagnostics/latest-report');

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">最新レポート診断</h1>
        <p className="mt-2 text-sm text-zinc-600">
          /chat で全体分析を実行した後、最新 chat_reports が全件カバレッジ・月別rollup・品質ゲートを満たしているか確認します。
        </p>
      </div>

      {loading && <div className="card p-5">診断中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}

      {data && (
        <>
          <div className="card p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">status {statusLabel(data.status)}</span>
              <span className="badge">score {data.score}</span>
              <span className="badge">critical failed {data.critical_failed.length}</span>
              <span className="badge">high failed {data.high_failed.length}</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-700">{data.summary}</p>
            {data.report && (
              <div className="mt-4 text-sm text-zinc-600">
                <p>report_id: {data.report.id}</p>
                <p>created_at: {data.report.created_at}</p>
                <p className="mt-2 whitespace-pre-wrap rounded-xl bg-zinc-50 p-3 text-xs leading-5">{data.report.answer_head}</p>
              </div>
            )}
          </div>

          <div className="card p-5">
            <h2 className="font-bold">チェック結果</h2>
            <div className="mt-3 grid gap-2">
              {data.checks.map((check) => (
                <div key={check.key} className={`rounded-xl border p-3 text-sm ${severityClass(check.severity, check.passed)}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{check.passed ? 'PASS' : 'FAIL'}</span>
                    <span>{check.key}</span>
                    <span className="text-xs">{check.severity}</span>
                  </div>
                  <p className="mt-1 text-xs">expected: {check.expected}</p>
                  <p className="mt-1 break-all text-xs">actual: {stringify(check.actual)}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
