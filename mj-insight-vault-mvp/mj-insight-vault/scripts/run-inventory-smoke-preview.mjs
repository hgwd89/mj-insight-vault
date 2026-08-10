import { spawn } from 'node:child_process';

const branch = process.env.VERCEL_GIT_COMMIT_REF || '';
if (branch !== 'agent/inventory-smoke-v2') {
  console.log('[preview-smoke] skipped outside dedicated branch');
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
  const created=await invoke('/api/chat/jobs','provisional-report-create',30000,{method:'POST',headers:appHeaders(),body:JSON.stringify({
    query,
    model:'gpt-4o-mini',
    target_scope:'all',
    output_template:'auto',
    require_full_corpus:false,
    report_requirements:'暫定テストレポート。結論、主要テーマ、根拠記事、反証・制約、実務含意、追加調査課題を含める。記事にないことは断定しない。',
    pipeline_version:'report_pipeline_v3',
    preview_e2e_smoke:'2026-08-10-v1'
  })});
  const job=created.parsed?.job||{};
  const id=String(job.id||'');
  if(!id) throw new Error(`provisional report job was not created: ${JSON.stringify(created.parsed).slice(0,1000)}`);

  for(let step=1;step<=8;step+=1){
    const run=await invoke(`/api/chat/jobs/${encodeURIComponent(id)}/run`,`provisional-report-run-${step}`,290000,{method:'POST',headers:appHeaders()});
    const state=run.parsed?.job||{};
    const status=String(state.status||'');
    const reportId=String(state.report_id||'');
    if(status==='completed'&&reportId){
      console.log(`[preview-smoke] provisional-report-e2e PASSED job_id=${id} report_id=${reportId}`);
      return {id,reportId};
    }
    if(status==='failed') throw new Error(`provisional report failed: ${String(state.error_message||run.parsed?.error||'unknown')}`);
    const retryAt=String(state.next_retry_at||'');
    if(retryAt){
      const ms=Math.max(500,Date.parse(retryAt)-Date.now()+250);
      await sleep(Math.min(ms,30000));
    } else await sleep(700);
  }
  throw new Error(`provisional report did not complete within smoke steps: job_id=${id}`);
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
