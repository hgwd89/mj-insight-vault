import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const monthly = read('lib/monthlyRollups.ts');
const worker = read('lib/monthlyRollupWorker.ts');
const monthlyContext = read('lib/monthlyRollupContext.ts');
const rollupApi = read('app/api/rollups/monthly/route.ts');
const workerApi = read('app/api/rollups/monthly/worker/route.ts');
const rollupPage = read('app/rollups/page.tsx');
const workerMigration = read('supabase/migrations/20260806100000_add_monthly_rollup_worker.sql');
const atomicArticleMigration = read('supabase/migrations/20260806162000_atomic_source_image_article_commit.sql');
const processRoute = read('app/api/source-images/[id]/process/route.ts');
const reprocessRoute = read('app/api/source-images/[id]/reprocess/route.ts');
const chatJobRun = read('app/api/chat/jobs/[id]/run/route.ts');
const chatRouteNo160 = read('lib/chatRouteNo160.ts');
const dateCases = JSON.parse(read('scripts/fixtures/rollup-date-cases.json'));

assert(/function monthKeyFromDate/.test(monthly), 'monthKeyFromDate() is missing.');
assert(/date\.match\(\^?\(\\d\{4\}\)年/.test(monthly) || monthly.includes('年\\s*(\\d{1,2})月'), 'Japanese date month parsing must be supported.');
assert(monthly.includes('slash') || monthly.includes('\\/'), 'Slash date month parsing must be supported.');
assert(/PAGE_SIZE = 1000/.test(monthly) && /\.range\(from, from \+ PAGE_SIZE - 1\)/.test(monthly), 'Monthly rollups must page through article rows.');
assert(/markMonthlyRollupsStaleForArticleDates/.test(monthly), 'Rollup stale marker is missing.');
assert(/\.neq\('status', 'running'\)/.test(monthly), 'Running rollups must not be forcibly marked stale.');
assert(/RUNNING_LOCK_MS/.test(monthly) && /isFreshRunningRollup/.test(monthly), 'Legacy direct generation must retain duplicate protection until removed.');
assert(/'provisional'/.test(monthly), 'Legacy fallback must remain explicitly provisional.');

assert(/stale_only/.test(rollupApi), 'stale_only rollup API mode is missing.');
assert(/needs_only/.test(rollupApi), 'needs_only rollup API mode is missing.');
assert(/month_key/.test(rollupApi), 'Single month rollup API mode is missing.');
assert(/all/.test(rollupApi), 'All-month rollup API mode is missing.');
assert(/enqueueMonthlyRollup/.test(rollupApi), 'Monthly API must enqueue work instead of executing a whole month synchronously.');
assert(!/generateMonthlyRollup/.test(rollupApi), 'Monthly API must not call the long synchronous generator.');
assert(/maxDuration = 60/.test(rollupApi), 'Queue API should remain a short request.');
assert(/queued_count/.test(rollupApi) && /generated_count: 0/.test(rollupApi), 'Queue API must not report queued work as completed generation.');

assert(/runMonthlyRollupWorkerStep/.test(workerApi), 'Monthly rollup worker endpoint is missing.');
assert(/maxDuration = 240/.test(workerApi), 'Monthly worker must stay below the Vercel 300 second boundary.');
assert(/claim_next_monthly_rollup/.test(worker), 'Worker must claim work atomically through the database.');
assert(/eq\('lease_token', token\)/.test(worker), 'Worker updates must be conditional on the claimed lease token.');
assert(/CALL_TIMEOUT_MS/.test(worker) && /AbortController/.test(worker), 'Every worker LLM call must have a bounded timeout.');
assert(/LEASE_SECONDS = boundedNumber\(process\.env\.MONTHLY_ROLLUP_LEASE_SECONDS, 270, 270, 480\)/.test(worker), 'Monthly rollup lease must outlive the 240 second Vercel worker ceiling by at least 30 seconds.');
assert(/sourceFingerprint/.test(worker) && /compactArticle\(article\)/.test(worker), 'Source fingerprint must include compact article content, not IDs alone.');
assert(/request_char_budget/.test(worker) && /preflight budget exceeded/.test(worker), 'Worker must reject oversized requests before OpenAI calls.');
assert(/formal monthly rollup evidence gate failed/.test(worker), 'Formal monthly output must have a grounded evidence gate.');
assert(/insufficient grounded evidence/.test(worker), 'Chunk/reduction output without concrete evidence must fail.');
assert(/refreshed\.fingerprint !== fingerprint/.test(worker), 'Worker must revalidate source content before marking a rollup ready.');
assert(/No extractive fallback was accepted as formal/.test(worker), 'Worker must never promote an extractive fallback.');
assert(/phase: 'chunks'/.test(worker) && /phase: 'reduce'/.test(worker), 'Worker must persist a resumable hierarchy state.');

assert(/for update skip locked/.test(workerMigration), 'Worker claim must use SKIP LOCKED for concurrent safety.');
assert(/lease_token/.test(workerMigration) && /lease_expires_at/.test(workerMigration), 'Worker migration must persist lease state.');
assert(/status in \('queued', 'stale', 'failed', 'provisional'\)/.test(workerMigration), 'Retryable monthly states must be claimable.');
assert(/status = 'running'.*lease_expires_at/s.test(workerMigration), 'Expired running work must be recoverable.');
assert(/mj_monthly_rollup_worker/.test(workerMigration) && /kick_monthly_rollup_worker/.test(workerMigration), 'Server-side monthly worker cron is missing.');

assert(/validatedReady/.test(monthlyContext), 'Report context must validate ready rollups, not trust status alone.');
assert(/rollup_analysis_is_validated/.test(monthlyContext), 'Report context must require a validated rollup flag.');
assert(/invalid_ready_months/.test(monthlyContext), 'Legacy or invalid ready months must be diagnosed.');
assert(/hierarchical_llm_worker/.test(monthlyContext), 'Worker-generated rollups must be explicitly recognized.');
assert(/pending_months/.test(monthlyContext), 'Pending rollup months must be surfaced to the report gate.');

assert(/queued_count/.test(rollupPage) && !/json\.rollups\b/.test(rollupPage), 'Rollup UI must use the queued subset rather than all database rows.');
assert(/完了ではありません/.test(rollupPage), 'Rollup UI must not describe queue acceptance as completion.');
assert(/pending_months/.test(rollupPage) && /10_000/.test(rollupPage), 'Rollup UI must poll pending work.');
assert(/invalid_ready_months/.test(rollupPage), 'Rollup UI must expose invalid legacy ready rows.');

assert(/update public\.monthly_rollups/.test(atomicArticleMigration), 'Atomic article creation must stale affected rollup months in the same transaction.');
assert(/v_affected_dates/.test(atomicArticleMigration), 'Atomic replacement must include both retired and newly created article months.');
assert(/stale_rollup_months/.test(processRoute), 'New OCR article response must expose invalidated rollup months.');
assert(/stale_rollup_months/.test(reprocessRoute), 'Reprocess response must expose invalidated rollup months.');
assert(/buildMonthlyRollupContext/.test(chatRouteNo160), 'Chat analysis route must build monthly rollup context.');
assert(!/buildMonthlyRollupContext/.test(chatJobRun), 'Chat job run must not inject monthly rollup context separately.');
assert(/runChatAnalysis/.test(chatJobRun), 'Chat job run must use the shared chat analysis route.');
assert(/monthly_rollup_used/.test(chatRouteNo160), 'Chat result must expose monthly rollup usage metadata.');
assert(/monthly_rollups/.test(monthlyContext) && /readyRows/.test(monthlyContext), 'Monthly rollup context should query and filter ready rollups.');
assert(/missing_months/.test(monthlyContext) && /stale_months/.test(monthlyContext) && /failed_months/.test(monthlyContext), 'Monthly rollup context must expose missing/stale/failed months.');

const functionMatch = monthly.match(/export function monthKeyFromDate[\s\S]*?  return UNDATED_MONTH_KEY;\r?\n}/);
assert(functionMatch, 'monthKeyFromDate() source could not be extracted for fixture execution.');
const executableSource = `const UNDATED_MONTH_KEY = 'undated';
${functionMatch[0]
  .replace('export function', 'function')
  .replace('(value: unknown)', '(value)')}; monthKeyFromDate;`;
const monthKeyFromDate = vm.runInNewContext(executableSource);

for (const testCase of dateCases) {
  const actual = monthKeyFromDate(testCase.input);
  assert(actual === testCase.expected, `monthKeyFromDate(${JSON.stringify(testCase.input)}) expected ${testCase.expected}, got ${actual}`);
}

console.log('verify-rollup-logic: ok');