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
const monthlyContext = read('lib/monthlyRollupContext.ts');
const rollupApi = read('app/api/rollups/monthly/route.ts');
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
assert(/RUNNING_LOCK_MS/.test(monthly) && /isFreshRunningRollup/.test(monthly), 'Fresh running rollups must be protected from duplicate generation.');

assert(/stale_only/.test(rollupApi), 'stale_only rollup API mode is missing.');
assert(/needs_only/.test(rollupApi), 'needs_only rollup API mode is missing.');
assert(/month_key/.test(rollupApi), 'Single month rollup API mode is missing.');
assert(/all/.test(rollupApi), 'All-month rollup API mode is missing.');

assert(/markMonthlyRollupsStaleForArticleDates/.test(processRoute), 'New OCR article creation must stale the related rollup month.');
assert(/markMonthlyRollupsStaleForArticleDates/.test(reprocessRoute), 'Reprocess must stale the related rollup month.');
assert(/buildMonthlyRollupContext/.test(chatRouteNo160), 'Chat analysis route must build monthly rollup context.');
assert(!/buildMonthlyRollupContext/.test(chatJobRun), 'Chat job run must not inject monthly rollup context separately.');
assert(/runChatAnalysis/.test(chatJobRun), 'Chat job run must use the shared chat analysis route.');
assert(/monthly_rollup_used/.test(chatRouteNo160), 'Chat result must expose monthly rollup usage metadata.');
assert(/monthly_rollups/.test(monthlyContext) && /readyRows/.test(monthlyContext), 'Monthly rollup context should use ready rollups.');
assert(/missing_months/.test(monthlyContext) && /stale_months/.test(monthlyContext) && /failed_months/.test(monthlyContext), 'Monthly rollup context must expose missing/stale/failed months.');

const functionMatch = monthly.match(/export function monthKeyFromDate[\s\S]*?  return '';\r?\n}/);
assert(functionMatch, 'monthKeyFromDate() source could not be extracted for fixture execution.');
const executableSource = `${functionMatch[0]
  .replace('export function', 'function')
  .replace('(value: unknown)', '(value)')}; monthKeyFromDate;`;
const monthKeyFromDate = vm.runInNewContext(executableSource);

for (const testCase of dateCases) {
  const actual = monthKeyFromDate(testCase.input);
  assert(actual === testCase.expected, `monthKeyFromDate(${JSON.stringify(testCase.input)}) expected ${testCase.expected}, got ${actual}`);
}

console.log('verify-rollup-logic: ok');
