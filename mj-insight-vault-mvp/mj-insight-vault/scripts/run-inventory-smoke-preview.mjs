import { spawn } from 'node:child_process';

const branch = process.env.VERCEL_GIT_COMMIT_REF || '';
if (branch !== 'agent/inventory-smoke-v2') {
  console.log('[preview-smoke] skipped outside dedicated branch');
  process.exit(0);
}

const nonce = 'k1Pw1mPHc7DkzLhoMdWB0ds8gg1-699k';
const reportRunId = '92346b9b-133f-43b7-b855-30c39998b1ac';
const port = 3999;
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port) }
});
child.stdout.on('data', (chunk) => process.stdout.write(`[next-start] ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`[next-start] ${chunk}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('local Next server did not become ready');
}
async function invoke(path, label, timeout=175000) {
  const sep=path.includes('?')?'&':'?';
  const res = await fetch(`http://127.0.0.1:${port}${path}${sep}nonce=${encodeURIComponent(nonce)}`, { signal: AbortSignal.timeout(timeout) });
  const body = await res.text();
  console.log(`[preview-smoke] ${label} status=${res.status} body=${body.slice(0,12000)}`);
  let parsed = {};
  try { parsed = JSON.parse(body); } catch {}
  return { res, parsed };
}
function terminal(parsed) {
  const stage = String(parsed.stage || '');
  const jobStatus = String(parsed?.job?.status || parsed?.result?.status || '');
  return stage === 'needs_review' || stage === 'failed_or_requeued' || jobStatus === 'needs_review' || jobStatus === 'failed';
}

try {
  await ready();
  const repair = await invoke('/api/buildcheck/inventory-smoke-critic-repair', 'critic-repair');
  if (!terminal(repair.parsed)) {
    for (let step = 1; step <= 6; step += 1) {
      const { parsed } = await invoke('/api/buildcheck/inventory-smoke-v2c', `inventory-step=${step}`);
      const stage = String(parsed.stage || '');
      const jobStatus = String(parsed?.job?.status || parsed?.result?.status || '');
      if (terminal(parsed)) break;
      if (stage === 'finalize' || jobStatus === 'completed' || (parsed.claimed === 0 && jobStatus !== 'queued' && jobStatus !== 'running')) break;
      await sleep(400);
    }
  }

  const status = await invoke(`/api/buildcheck/report-readiness?action=status&id=${encodeURIComponent(reportRunId)}`, 'report-scan-before', 15000);
  const runStatus=String(status.parsed?.run?.status||status.parsed?.status||'');
  if (runStatus !== 'completed' && runStatus !== 'failed') {
    await invoke(`/api/buildcheck/report-readiness?action=advance&id=${encodeURIComponent(reportRunId)}&limit=4`, 'report-scan-advance-4', 260000);
  }
  await invoke(`/api/buildcheck/report-readiness?action=status&id=${encodeURIComponent(reportRunId)}`, 'report-scan-after', 15000);
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  if (!child.killed) child.kill('SIGKILL');
}
