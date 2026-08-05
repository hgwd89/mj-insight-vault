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
assertIncludes(panel, "mj-chat-active-run-v2", 'report UI must persist resumable job state');
assertIncludes(panel, "router.push('/reports')", 'report UI must hand off execution to the global provider');
assertIncludes(panel, "useState('gpt-5-mini')", 'report UI must not default to the most expensive model');

const shell = read('components/ChatPanelShell.tsx');
assertIncludes(shell, "ReportJobPanel", 'chat page must use the persistent report panel');
assertExcludes(shell, "import { ChatPanel }", 'chat page must not expose the legacy direct-request panel');

const runner = read('app/api/chat/jobs/[id]/run/route.ts');
assertIncludes(runner, 'prepareReportCorpus', 'job runner must prepare the corpus before report generation');
assertIncludes(runner, "status: 'queued'", 'incomplete scan work must return to the queue');
assertIncludes(runner, '{ status: 202 }', 'incomplete scan work must be reported as pending');
assertIncludes(runner, 'pipelineSnapshot', 'job state must persist bounded pipeline diagnostics');

const pipeline = read('lib/reportPipeline.ts');
assertIncludes(pipeline, 'run_stale_article_count_mismatch', 'stale corpus runs must be rebuilt');
assertIncludes(pipeline, 'createFullCorpusScanRun', 'pipeline must create a current scan run');
assertIncludes(pipeline, 'runFullCorpusScanBatches', 'pipeline must advance scan batches');
assertIncludes(pipeline, 'MAX_CONTEXT_CHARS', 'final report context must have a hard prompt budget');
assertIncludes(pipeline, 'detail_omitted_for_prompt_budget', 'every completed batch must remain represented when details are bounded');

const guard = read('lib/chatRouteFullCorpusGuard.ts');
assertIncludes(guard, 'getBoundedFullCorpusContext', 'formal report generation must use bounded corpus context');
assertExcludes(guard, "from '@/lib/fullCorpusScan'", 'formal report generation must not inject every raw batch summary');

const statusRoute = read('app/api/chat/jobs/[id]/route.ts');
assertIncludes(statusRoute, '6 * 60 * 1000', 'stale recovery must not race a valid five-minute report step');

console.log('Report pipeline regression checks passed.');
