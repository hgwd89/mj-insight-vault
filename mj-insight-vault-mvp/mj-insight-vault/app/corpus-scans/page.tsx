'use client';

import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const DEFAULT_BEAUTY_RUN = '14728c1f-04c3-4034-86ce-336e76d1ccbb';
const DEFAULT_ALL_RUN = 'e9e6e597-8830-4532-80ac-b24f8a5ad4b5';

export default function Page() {
  const password = useAppPassword();
  const [runId, setRunId] = useState(DEFAULT_BEAUTY_RUN);
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
        <p className="mt-2 text-sm text-zinc-600">まず化粧品カテゴリを1バッチだけ実行して、失敗やneeds_reviewを確認します。</p>
      </div>
      <div className="card p-5 space-y-3">
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={() => setRunId(DEFAULT_BEAUTY_RUN)}>beauty_cosmetics</button>
          <button className="btn" type="button" onClick={() => setRunId(DEFAULT_ALL_RUN)}>all</button>
        </div>
        <label className="block text-sm font-bold">run id</label>
        <input className="input" value={runId} onChange={(e) => setRunId(e.target.value)} />
        <label className="block text-sm font-bold">batch_limit</label>
        <input className="input" type="number" min={1} max={5} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        <button className="btn btn-primary" type="button" onClick={runOnce} disabled={busy || !runId}>1回実行</button>
      </div>
      <div className="card p-5">
        <pre className="overflow-auto whitespace-pre-wrap text-xs">{result}</pre>
      </div>
    </div>
  );
}
