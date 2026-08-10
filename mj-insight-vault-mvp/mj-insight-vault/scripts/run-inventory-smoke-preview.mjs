import { spawn } from 'node:child_process';

const branch = process.env.VERCEL_GIT_COMMIT_REF || '';
if (branch !== 'agent/inventory-smoke-v2') {
  console.log('[preview-smoke] skipped outside dedicated branch');
  process.exit(0);
}
if (process.env.ALLOW_PREVIEW_SMOKE !== '1') {
  console.log('[preview-smoke] skipped: set ALLOW_PREVIEW_SMOKE=1 for explicit side-effectful execution');
  process.exit(0);
}

const nonce = 'k1Pw1mPHc7DkzLhoMdWB0ds8gg1-699k';
const staleReportRunId = '92346b9b-133f-43b7-b855-30c39998b1ac';
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
async function invoke(path, label, timeout=175000, init={}) {
  const sep=path.includes('?')?'&':'?';
  const res = await fetch(`http://127.0.0.1:${port}${path}${sep}nonce=${encodeURIComponent(nonce)}`, { ...init, signal: AbortSignal.timeout(timeout) });
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
function appHeaders(){
  const password=process.env.APP_PASSWORD||'';
  if(!password) throw new Error('APP_PASSWORD is missing in preview build');
  return {'content-type':'application/json','x-app-password':password};
}

async function runProvisionalReportSmoke(){
  const query='【Preview E2E smoke 2026-08-10】生活者が物価上昇下で何を維持し、何を削っているか。根拠記事、反証・制約、実務含意、追加調査課題を分けて整理してください。';
  const generated=await invoke('/api/report-test','provisional-report-generate',290000,{method:'POST',headers:appHeaders(),body:JSON.stringify({query,model:'gpt-4o-mini'})});
  if(!generated.res.ok){
    throw new Error(`provisional report generation failed: ${JSON.stringify(generated.parsed).slice(0,2000)}`);
  }
  const reportId=String(generated.parsed?.report?.id||'');
  if(!reportId) throw new Error(`provisional report was not saved: ${JSON.stringify(generated.parsed).slice(0,2000)}`);

  const readback=await invoke(`/api/reports/${encodeURIComponent(reportId)}`,'provisional-report-readback',30000,{headers:appHeaders()});
  const readbackId=String(readback.parsed?.report?.id||'');
  const formal=Boolean(readback.parsed?.report?.is_formal_report);
  const verification=String(readback.parsed?.report?.analysis_verification_status||'');
  if(!readback.res.ok||readbackId!==reportId) throw new Error(`provisional report readback failed: report_id=${reportId}`);
  if(formal) throw new Error(`preview report was incorrectly persisted as formal: report_id=${reportId}`);
  if(!verification.startsWith('provisional')&&verification!=='quality_unverified'){
    throw new Error(`unexpected preview verification status: ${verification||'empty'}`);
  }
  console.log(`[preview-smoke] provisional-report-e2e PASSED report_id=${reportId} verification=${verification}`);
  return reportId;
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

  const oldStatus = await invoke(`/api/buildcheck/report-readiness?action=status&id=${encodeURIComponent(staleReportRunId)}`, 'report-scan-old-status', 15000);
  const diff=Number(oldStatus.parsed?.context?.current_article_count_diff||0);
  const runStatus=String(oldStatus.parsed?.run?.status||oldStatus.parsed?.status||'');
  if(runStatus!=='completed'&&runStatus!=='failed'&&diff===0){
    const attempt=await invoke(`/api/buildcheck/report-readiness?action=advance&id=${encodeURIComponent(staleReportRunId)}&limit=1`, 'report-scan-old-advance-1', 260000);
    if(!attempt.res.ok){
      const fresh=await invoke('/api/buildcheck/report-readiness?action=create','report-scan-fresh-create',30000);
      const freshId=String(fresh.parsed?.run?.id||fresh.parsed?.id||'');
      if(freshId) await invoke(`/api/buildcheck/report-readiness?action=advance&id=${encodeURIComponent(freshId)}&limit=1`,'report-scan-fresh-advance-1',260000);
    }
  } else if(runStatus!=='completed') {
    const fresh=await invoke('/api/buildcheck/report-readiness?action=create','report-scan-fresh-create',30000);
    const freshId=String(fresh.parsed?.run?.id||fresh.parsed?.id||'');
    if(freshId) await invoke(`/api/buildcheck/report-readiness?action=advance&id=${encodeURIComponent(freshId)}&limit=1`,'report-scan-fresh-advance-1',260000);
  }

  await runProvisionalReportSmoke();
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  if (!child.killed) child.kill('SIGKILL');
}
