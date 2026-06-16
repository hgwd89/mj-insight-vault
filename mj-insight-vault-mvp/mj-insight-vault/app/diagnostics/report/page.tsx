'use client';

import { useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

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

type Job = {
  id: string;
  status: string;
  progress: number;
  stage: string;
  error_message?: string | null;
  report_id?: string | null;
};

const DEFAULT_QUERY = `全記事を対象に、全データを広域スキャンしたうえで分析してください。
MJ記事群から、生活者インサイト、生活者ナラティブ、調査すべき論点を抽出してください。
目的はリサーチのネタ発見です。商品開発・販促・チャネルなどの実行アクション提案は不要です。

特に以下を必須にしてください。
1. カバレッジ診断
2. 生活者動向のナラティブ
3. 説明仮説とWHY3段階
4. 反証・別解釈
5. 根拠マトリクス
6. 調査が必要そうな論点
7. negative_space
8. confidence_rubric`;

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ReportDiagnosticsPage() {
  const password = useAppPassword();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading } = useApi<Diagnostics>(`/api/diagnostics/latest-report?r=${refreshKey}`);
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [job, setJob] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');

  function refreshDiagnostics() {
    setRefreshKey((value) => value + 1);
  }

  async function fetchJson(url: string, init?: RequestInit) {
    const res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-app-password': password,
        ...(init?.headers || {})
      }
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
    return json;
  }

  async function pollJob(jobId: string) {
    for (;;) {
      const json = await fetchJson(`/api/chat/jobs/${jobId}`);
      const nextJob = json.job as Job;
      setJob(nextJob);

      if (nextJob.status === 'completed') {
        refreshDiagnostics();
        return;
      }
      if (nextJob.status === 'failed') {
        throw new Error(nextJob.error_message || '分析ジョブが失敗しました');
      }
      if (nextJob.status === 'queued') {
        await fetchJson(`/api/chat/jobs/${jobId}/run`, { method: 'POST', body: '{}' }).catch(() => null);
      }
      await sleep(5000);
    }
  }

  async function runDiagnosticReport() {
    const ok = window.confirm('全記事対象の診断用レポートを実行します。時間がかかります。開始しますか。');
    if (!ok) return;
    setRunning(true);
    setRunError('');
    setJob(null);

    try {
      const created = await fetchJson('/api/chat/jobs', {
        method: 'POST',
        body: JSON.stringify({
          query,
          target_scope: 'all',
          conversation: [],
          model: 'gpt-5'
        })
      });
      const createdJob = created.job as Job;
      setJob(createdJob);
      await fetchJson(`/api/chat/jobs/${createdJob.id}/run`, { method: 'POST', body: '{}' }).catch(() => null);
      await pollJob(createdJob.id);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : '診断用レポートの実行に失敗しました');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">最新レポート診断</h1>
        <p className="mt-2 text-sm text-zinc-600">
          全体分析を実行した後、最新 chat_reports が全件カバレッジ・月別rollup・品質ゲートを満たしているか確認します。
        </p>
      </div>

      <div className="card p-5">
        <h2 className="font-bold">診断用の全体分析を実行</h2>
        <p className="mt-2 text-sm text-zinc-600">
          ここから全記事対象の分析ジョブを作成し、完了後にこのページの診断結果を更新します。
        </p>
        <textarea
          className="input mt-3 min-h-44 w-full text-sm leading-6"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={running}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={runDiagnosticReport} disabled={running || !query.trim()}>
            {running ? '実行中' : '全体分析を実行して診断'}
          </button>
          <button className="btn" type="button" onClick={refreshDiagnostics} disabled={running}>診断だけ更新</button>
        </div>
        {job && (
          <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
            <div className="flex flex-wrap gap-2">
              <span className="badge">job {job.status}</span>
              <span className="badge">{job.progress}%</span>
              {job.report_id && <span className="badge">report saved</span>}
            </div>
            <p className="mt-2">{job.stage}</p>
          </div>
        )}
        {runError && <p className="mt-3 text-sm text-red-600">{runError}</p>}
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
