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
assertIncludes(panel, 'mj-chat-active-run-v3', 'report UI must use the hardened resumable job state');
assertIncludes(panel, 'window.localStorage.setItem', 'report UI must survive browser and tab closure');
assertIncludes(panel, 'response.status === 409', 'report UI must recover an existing active job');
assertIncludes(panel, "router.push('/reports')", 'report UI must hand off execution to the report list');
assertIncludes(panel, "useState('gpt-4o-mini')", 'report UI must default to the low-cost model');

const shell = read('components/ChatPanelShell.tsx');
assertIncludes(shell, 'ReportJobPanel', 'chat page must use the persistent report panel');
assertExcludes(shell, 'import { ChatPanel }', 'chat page must not expose the legacy direct-request panel');

const jobsRoute = read('app/api/chat/jobs/route.ts');
assertIncludes(jobsRoute, "PIPELINE_VERSION = 'report_pipeline_v3'", 'new jobs must be versioned');
assertIncludes(jobsRoute, "url.searchParams.get('active')", 'active jobs must be server-discoverable');
assertIncludes(jobsRoute, 'active_job_exists', 'multiple active report jobs must be rejected');
assertIncludes(jobsRoute, "inserted.error.code === '23505'", 'active job creation must be race safe');
assertIncludes(jobsRoute, 'MAX_QUERY_CHARS', 'report requests must have a bounded query size');

const runner = read('app/api/chat/jobs/[id]/run/route.ts');
assertIncludes(runner, 'prepareReportCorpus', 'job runner must prepare the corpus before report generation');
assertIncludes(runner, "rpc('claim_chat_job'", 'job runner must atomically claim the job');
assertIncludes(runner, ".eq('lease_token', leaseToken)", 'all worker writes must preserve lease ownership');
assertIncludes(runner, 'MAX_CONSECUTIVE_TRANSIENT_FAILURES', 'only consecutive transient failures may stop a long scan');
assertIncludes(runner, 'attempt_count: 0', 'successful scan progress must reset transient failure count');
assertIncludes(runner, 'preparation.context.next_retry_at || null', 'job execution must honor scan retry delays');
assertIncludes(runner, 'findSavedFormalReport', 'saved verified reports must be recovered before model execution');
assertIncludes(runner, ".eq('source_job_id', jobId)", 'report recovery must be scoped to the exact job');
assertIncludes(runner, 'completed_recovered: true', 'saved report recovery must complete the job');
assertIncludes(runner, 'source_job_id: sourceJobId', 'report persistence must attach the source job');
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
assertIncludes(scan, 'allowedIds.has(id)', 'model-supplied evidence IDs must be restricted to the current batch');
assertIncludes(scan, "full_corpus_batch_v2", 'prompt version must invalidate unsafe prior runs');
assertIncludes(scan, '.slice(0, 4000)', 'scan article input must use the low-cost text budget');

const guard = read('lib/chatRouteFullCorpusGuard.ts');
assertIncludes(guard, 'getBoundedFullCorpusContext', 'formal report generation must use bounded corpus context');
assertIncludes(guard, 'patch.source_job_id = sourceJobId', 'formal reports must be linked to their source jobs');
assertExcludes(guard, "from '@/lib/fullCorpusScan'", 'formal report generation must not inject every raw batch summary');

const statusRoute = read('app/api/chat/jobs/[id]/route.ts');
assertIncludes(statusRoute, 'lease_expires_at', 'stale recovery must use worker leases');
assertIncludes(statusRoute, ".eq('lease_token', currentLease)", 'stale recovery must use compare-and-swap');

const migration = read('supabase/migrations/20260805090000_harden_report_job_pipeline.sql');
assertIncludes(migration, 'claim_chat_job', 'migration must provide an atomic job claim');
assertIncludes(migration, 'claim_full_corpus_scan_batch', 'migration must provide an atomic batch claim');
assertIncludes(migration, 'full_corpus_scan_runs_active_fingerprint_uidx', 'migration must prevent duplicate active scan runs');

const attemptFixMigration = read('supabase/migrations/20260805093000_fix_report_job_attempt_semantics.sql');
assertIncludes(attemptFixMigration, 'chat_jobs_single_active_v3_uidx', 'database must prevent concurrent active v3 report jobs');
assertIncludes(attemptFixMigration, 'create or replace function public.claim_chat_job', 'attempt fix must replace the claim function');
assertExcludes(attemptFixMigration, 'attempt_count = j.attempt_count + 1', 'normal scan progress must not consume the transient failure budget');

const reportLinkMigration = read('supabase/migrations/20260805094500_link_reports_to_jobs.sql');
assertIncludes(reportLinkMigration, 'source_job_id uuid', 'reports must store the source job id');
assertIncludes(reportLinkMigration, 'chat_reports_source_job_id_uidx', 'one job must map to at most one report');

console.log('Report pipeline hardening regression checks passed.');
