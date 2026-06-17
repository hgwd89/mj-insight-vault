'use client';

import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const RUNS = [
  { label: 'beauty_cosmetics｜191件｜7バッチ', id: '14728c1f-04c3-4034-86ce-336e76d1ccbb' },
  { label: 'all｜1249件｜42バッチ', id: 'e9e6e597-8830-4532-80ac-b24f8a5ad4b5' },
  { label: 'retail_channel｜482件｜17バッチ', id: '9803db62-1ed6-4d7a-a2d6-3ae4b08a043e' },
  { label: 'food_beverage｜346件｜12バッチ', id: '1941de1a-79f3-4b29-a1e2-60661783192a' },
  { label: 'finance_value｜459件｜16バッチ', id: '9d28ca15-5bbd-403a-8fd1-3f2cb28e8cd7' }
];

export default function Page() {
  const password = useAppPassword();
  const [runId, setRunId] = useState(RUNS[0].id);
  const [limit, setLimit] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  async function runOnce() {
    setBusy(true);
    setResult('running...');
    try {
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
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">Corpus Scan Runner</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          まず beauty_cosmetics を batch_limit=1 で実行します。completed なら残りを進め、needs_review / failed ならプロンプトかvalidationを直します。
        </p>
      </div>
      <div className="card p-5 space-y-3">
        <label className="block text-sm font-bold">対象run</label>
        <select className="input" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={busy}>
          {RUNS.map((run) => <option key={run.id} value={run.id}>{run.label}</option>)}
        </select>
        <label className="block text-sm font-bold">run id</label>
        <input className="input" value={runId} onChange={(e) => setRunId(e.target.value)} disabled={busy} />
        <label className="block text-sm font-bold">batch_limit</label>
        <input className="input" type="number" min={1} max={5} value={limit} onChange={(e) => setLimit(Number(e.target.value))} disabled={busy} />
        <button className="btn btn-primary" type="button" onClick={runOnce} disabled={busy || !runId}>1回実行</button>
      </div>
      <div className="card p-5">
        <pre className="overflow-auto whitespace-pre-wrap text-xs">{result}</pre>
      </div>
    </div>
  );
}
