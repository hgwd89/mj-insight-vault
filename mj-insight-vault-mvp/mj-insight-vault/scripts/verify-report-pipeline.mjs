import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
  }
}

function assertExcludes(source, unexpected, label) {
  if (source.includes(unexpected)) {
    throw new Error(`${label}: unexpected ${JSON.stringify(unexpected)}`);
  }
}

const panel = read('components/ReportJobPanel.tsx');
assertIncludes(panel, "fetch('/api/chat/jobs'", 'report UI must create a persistent job');
assertExcludes(panel, "fetch('/api/chat'", 'report UI must not use the single-request chat route');
assertIncludes(panel, "mj-chat-active-run-v3", 'report UI must use the hardened resumable job state');
assertIncludes(panel, 'window.localStorage.setItem', 'report UI must survive browser and tab closure');
assertIncludes(panel, 'response.status === 409', 'report UI must recover an existing active job');
assertIncludes(panel, "router.push('/reports')", 'report UI must hand off execution to the report list');
assertIncludes(panel, "useState('gpt-5-mini')", 'report UI must not default to the most expensive model');

const shell = read('components/ChatPanelShell.tsx');
assertIncludes(shell, 'ReportJobPanel', 'chat page must use the persistent report panel');
assertExcludes(shell, 'import { ChatPanel }', 'chat page must not expose the legacy direct-request panel');

const jobsRoute = read('app/api/chat/jobs/route.ts');
assertIncludes(jobsRoute, "PIPELINE_VERSION = 'report_pipeline_v3'", 'new jobs must be versioned');
assertIncludes(jobsRoute, "url.searchParams.get('active')", 'active jobs must be server-discoverable');
assertIncludes(jobsRoute, 'active_job_exists', 'multiple active report jobs must be rejected');
assertIncludes(jobsRoute, 'MAX_QUERY_CHARS', 'report requests must have a bounded query size');

const runner = read('app/api/chat/jobs/[id]/run/route.ts');
assertIncludes(runner, 'prepareReportCorpus', 'job runner must prepare the corpus before report generation');
assertIncludes(runner, "rpc('claim_chat_job'", 'job runner must atomically claim the job');
assertIncludes(runner, ".eq('lease_token', leaseToken)", 'all worker writes must preserve lease ownership');
assertIncludes(runner, 'retryableError', 'transient job failures must be classified');
assertIncludes(runner, 'retry_scheduled', 'transient job failures must be retried');
assertIncludes(runner, "status: 'queued'", 'incomplete scan work must return to the queue');
assertIncludes(runner, '{ status: 202 }', 'incomplete scan work must be reported as pending');
assertIncludes(runner, 'pipelineSnapshot', 'job state must persist bounded pipeline diagnostics');

const provider = read('components/ChatJobStatusProvider.tsx');
assertIncludes(provider, 'window.localStorage', 'job state must persist across browser sessions');
assertIncludes(provider, "fetch('/api/chat/jobs?active=1'", 'provider must recover server-side active jobs');
assertIncludes(provider, "window.addEventListener('storage'", 'provider must synchronize multiple tabs');
assertExcludes(provider, "if (pathname === '/chat') return", 'chat page must not stop job execution');

const pipeline = read('lib/reportPipeline.ts');
assertIncludes(pipeline, 'run_stale_article_count_mismatch', 'stale corpus runs must be rebuilt');
assertIncludes(pipeline, 'createFullCorpusScanRun', 'pipeline must create a current scan run');
assertIncludes(pipeline, 'runFullCorpusScanBatches', 'pipeline must advance scan batches');
assertIncludes(pipeline, 'terminal_batches', 'pipeline must distinguish terminal failures');
assertIncludes(pipeline, 'retryable_batches', 'pipeline must distinguish retryable work');
assertIncludes(pipeline, 'MAX_CONTEXT_CHARS', 'final report context must have a hard prompt budget');
assertIncludes(pipeline, 'detail_omitted_for_prompt_budget', 'every completed batch must remain represented when details are bounded');

const scan = read('lib/fullCorpusScan.ts');
assertIncludes(scan, 'corpusFingerprint', 'identical article populations must reuse a scan run');
assertIncludes(scan, 'claim_full_corpus_scan_batch', 'scan batches must be claimed atomically');
assertIncludes(scan, 'MAX_SCAN_TRANSIENT_ATTEMPTS', 'transient scan retries must be bounded');
assertIncludes(scan, 'MAX_SCAN_VALIDATION_ATTEMPTS', 'validation retries must be bounded');
assertIncludes(scan, 'OPENAI_SCAN_TIMEOUT_MS', 'scan model calls must have a timeout');
assertIncludes(scan, 'next_retry_at', 'scan retries must be delayed');
assertExcludes(scan, 'fallbackBatchSummary', 'provider failures must not be saved as fake analysis results');

const guard = read('lib/chatRouteFullCorpusGuard.ts');
assertIncludes(guard, 'getBoundedFullCorpusContext', 'formal report generation must use bounded corpus context');
assertExcludes(guard, "from '@/lib/fullCorpusScan'", 'formal report generation must not inject every raw batch summary');

const statusRoute = read('app/api/chat/jobs/[id]/route.ts');
assertIncludes(statusRoute, 'lease_expires_at', 'stale recovery must use worker leases');
assertIncludes(statusRoute, ".eq('lease_token', currentLease)", 'stale recovery must use compare-and-swap');

const migration = read('supabase/migrations/20260805090000_harden_report_job_pipeline.sql');
assertIncludes(migration, 'claim_chat_job', 'migration must provide an atomic job claim');
assertIncludes(migration, 'claim_full_corpus_scan_batch', 'migration must provide an atomic batch claim');
assertIncludes(migration, 'full_corpus_scan_runs_active_fingerprint_uidx', 'migration must prevent duplicate active scan runs');

console.log('Report pipeline hardening regression checks passed.');
