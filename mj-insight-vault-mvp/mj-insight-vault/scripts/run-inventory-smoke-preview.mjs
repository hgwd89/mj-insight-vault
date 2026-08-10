import { spawn } from 'node:child_process';

const branch = process.env.VERCEL_GIT_COMMIT_REF || '';
if (branch !== 'agent/inventory-smoke-v2') {
  console.log('[inventory-smoke] skipped outside dedicated branch');
  process.exit(0);
}

const nonce = 'k1Pw1mPHc7DkzLhoMdWB0ds8gg1-699k';
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

try {
  await ready();
  for (let step = 1; step <= 6; step += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/api/buildcheck/inventory-smoke-v2c?nonce=${encodeURIComponent(nonce)}`, { signal: AbortSignal.timeout(175000) });
    const body = await res.text();
    console.log(`[inventory-smoke] step=${step} status=${res.status} body=${body}`);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const stage = String(parsed.stage || '');
    const jobStatus = String(parsed?.job?.status || parsed?.result?.status || '');
    if (stage === 'needs_review' || stage === 'failed_or_requeued' || jobStatus === 'needs_review' || jobStatus === 'failed') break;
    if (stage === 'finalize' || jobStatus === 'completed' || (parsed.claimed === 0 && jobStatus !== 'queued' && jobStatus !== 'running')) break;
    await sleep(400);
  }
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  if (!child.killed) child.kill('SIGKILL');
}
