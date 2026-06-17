'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

type Run = {
  run_id: string;
  scope_type: string;
  scope_query: string | null;
  active_article_count: number;
  current_article_count: number;
  current_article_count_diff: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  needs_review_batches: number;
  analyzed_article_count: number;
  full_corpus_gate: string;
  gate_reason: string;
  execution_state: string;
  priority_score: number;
};

function label(run: Run) {
  const scope = run.scope_type === 'all' ? 'all' : run.scope_query || 'category';
  const stale = run.current_article_count_diff ? `｜STALE diff ${run.current_article_count_diff}` : '';
  return `${scope}｜${run.active_article_count}件｜${run.completed_batches}/${run.total_batches}バッチ｜${run.execution_state}${stale}`;
}

function shouldStop(run: Run | undefined) {
  if (!run) return 'done_or_missing_from_priority';
  if (run.execution_state === 'done') return 'done';
  if (run.execution_state === 'review_or_retry') return 'needs_review_or_failed';
  if (run.execution_state === 'stale_rebuild_required') return 'stale_rebuild_required';
  if (run.failed_batches > 0) return 'failed_batches_exist';
  if (run.needs_review_batches > 0) return 'needs_review_batches_exist';
  if (run.current_article_count_diff !== 0) return 'stale_article_count_diff';
  return '';
}

export default function Page() {
  const password = useAppPassword();
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState('');
  const [limit, setLimit] = useState(1);
  const [maxSteps, setMaxSteps] = useState(20);
  const [busy, setBusy] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [result, setResult] = useState('');
  const stopRef = useRef(false);

  async function loadRuns() {
    setBusy(true);
    try {
      const res = await fetch('/api/corpus-scans/priority', { headers: { 'x-app-password': password } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'priority取得に失敗しました');
      const nextRuns = json.runs || [];
      setRuns(nextRuns);
      if (!runId && nextRuns[0]?.run_id) setRunId(nextRuns[0].run_id);
      setResult(JSON.stringify({ loaded_runs: nextRuns.length, first: nextRuns[0] || null }, null, 2));
      return nextRuns as Run[];
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'load failed');
      return [] as Run[];
    } finally {
      setBusy(false);
    }
  }

  async function advanceOnce(targetRunId = runId, silent = false) {
    if (!targetRunId) throw new Error('run id がありません');
    const selected = runs.find((run) => run.run_id === targetRunId);
    const stop = shouldStop(selected);
    if (stop) throw new Error(`実行停止: ${stop}`);

    if (!silent) {
      setBusy(true);
      setResult('running...');
    }
    try {
      const res = await fetch('/api/corpus-scans/progress', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-app-password': password
        },
        body: JSON.stringify({ id: targetRunId, batch_limit: limit })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'progress failed');
      if (!silent) setResult(JSON.stringify(json, null, 2));
      return json;
    } finally {
      if (!silent) setBusy(false);
    }
  }

  async function runOnce() {
    setBusy(true);
    try {
      await advanceOnce(runId, false);
      await loadRuns();
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function autoRun() {
    const targetRunId = runId;
    if (!targetRunId) return;
    stopRef.current = false;
    setAutoRunning(true);
    setBusy(true);
    const log: unknown[] = [];
    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        if (stopRef.current) {
          log.push({ step, stopped_by_user: true });
          break;
        }
        const latestRuns = await loadRuns();
        const latest = latestRuns.find((run) => run.run_id === targetRunId);
        const stop = shouldStop(latest);
        if (stop) {
          log.push({ step, stopped: stop, latest });
          break;
        }
        setResult(JSON.stringify({ auto_step: step, status: 'running', latest, log }, null, 2));
        const json = await advanceOnce(targetRunId, true);
        log.push({ step, completed_batches: json.run?.completed_batches, total_batches: json.run?.total_batches, status: json.run?.status, failed_batches: json.run?.failed_batches, needs_review_batches: json.run?.needs_review_batches });
        setResult(JSON.stringify({ auto_step: step, status: 'advanced', last: log[log.length - 1], log }, null, 2));
      }
      const finalRuns = await loadRuns();
      setResult(JSON.stringify({ auto_finished: true, selected_run_id: targetRunId, final: finalRuns.find((run) => run.run_id === targetRunId) || null, log }, null, 2));
    } catch (error) {
      setResult(JSON.stringify({ auto_failed: true, error: error instanceof Error ? error.message : 'failed', log }, null, 2));
    } finally {
      setAutoRunning(false);
      setBusy(false);
    }
  }

  function stopAutoRun() {
    stopRef.current = true;
  }

  useEffect(() => { void loadRuns(); }, []);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">Corpus Scan Runner</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          DBの優先順位viewからrunを動的取得します。stale runは実行しません。まず batch_limit=1 で検証し、問題なければ自動実行してください。
        </p>
      </div>
      <div className="card p-5 space-y-3">
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={loadRuns} disabled={busy}>run一覧更新</button>
          <button className="btn" type="button" onClick={runOnce} disabled={busy || !runId}>選択runを1回実行</button>
          <button className="btn btn-primary" type="button" onClick={autoRun} disabled={busy || autoRunning || !runId}>選択runを自動実行</button>
          <button className="btn" type="button" onClick={stopAutoRun} disabled={!autoRunning}>停止</button>
        </div>
        <label className="block text-sm font-bold">対象run</label>
        <select className="input" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={busy}>
          {runs.map((run) => <option key={run.run_id} value={run.run_id}>{label(run)}</option>)}
        </select>
        <label className="block text-sm font-bold">run id</label>
        <input className="input" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={busy} />
        <label className="block text-sm font-bold">batch_limit</label>
        <input className="input" type="number" min={1} max={5} value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={busy} />
        <label className="block text-sm font-bold">auto max steps</label>
        <input className="input" type="number" min={1} max={100} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} disabled={busy} />
      </div>
      <div className="card p-5">
        <pre className="overflow-auto whitespace-pre-wrap text-xs">{result}</pre>
      </div>
    </div>
  );
}
