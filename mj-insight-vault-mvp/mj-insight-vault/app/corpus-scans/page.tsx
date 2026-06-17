'use client';

import { useEffect, useState } from 'react';
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

export default function Page() {
  const password = useAppPassword();
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState('');
  const [limit, setLimit] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

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
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'load failed');
    } finally {
      setBusy(false);
    }
  }

  async function runOnce() {
    setBusy(true);
    setResult('running...');
    try {
      const selected = runs.find((run) => run.run_id === runId);
      if (selected?.execution_state === 'stale_rebuild_required') {
        setResult('このrunは記事数が変わっているためstaleです。再作成が必要です。実行しません。');
        return;
      }
      const res = await fetch('/api/corpus-scans/progress', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-app-password': password
        },
        body: JSON.stringify({ id: runId, batch_limit: limit })
      });
      const json = await res.json();
      setResult(JSON.stringify(json, null, 2));
      await loadRuns();
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void loadRuns(); }, []);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">Corpus Scan Runner</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          DBの優先順位viewからrunを動的取得します。stale runは実行せず、記事数が一致するrunだけ進めます。まず batch_limit=1 で検証してください。
        </p>
      </div>
      <div className="card p-5 space-y-3">
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={loadRuns} disabled={busy}>run一覧更新</button>
          <button className="btn btn-primary" type="button" onClick={runOnce} disabled={busy || !runId}>選択runを1回実行</button>
        </div>
        <label className="block text-sm font-bold">対象run</label>
        <select className="input" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={busy}>
          {runs.map((run) => <option key={run.run_id} value={run.run_id}>{label(run)}</option>)}
        </select>
        <label className="block text-sm font-bold">run id</label>
        <input className="input" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={busy} />
        <label className="block text-sm font-bold">batch_limit</label>
        <input className="input" type="number" min={1} max={5} value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={busy} />
      </div>
      <div className="card p-5">
        <pre className="overflow-auto whitespace-pre-wrap text-xs">{result}</pre>
      </div>
    </div>
  );
}
