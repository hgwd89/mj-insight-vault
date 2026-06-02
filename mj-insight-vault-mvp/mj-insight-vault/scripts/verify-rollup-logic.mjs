import fs from 'node:fs';
import path from 'node:path';

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

assert(/function monthKeyFromDate/.test(monthly), 'monthKeyFromDate() is missing.');
assert(/date\.match\(\^?\(\\d\{4\}\)年/.test(monthly) || monthly.includes('年\\s*(\\d{1,2})月'), 'Japanese date month parsing must be supported.');
assert(/PAGE_SIZE = 1000/.test(monthly) && /\.range\(from, from \+ PAGE_SIZE - 1\)/.test(monthly), 'Monthly rollups must page through article rows.');
assert(/markMonthlyRollupsStaleForArticleDates/.test(monthly), 'Rollup stale marker is missing.');
assert(/\.neq\('status', 'running'\)/.test(monthly), 'Running rollups must not be forcibly marked stale.');

assert(/stale_only/.test(rollupApi), 'stale_only rollup API mode is missing.');
assert(/month_key/.test(rollupApi), 'Single month rollup API mode is missing.');
assert(/all/.test(rollupApi), 'All-month rollup API mode is missing.');

assert(/markMonthlyRollupsStaleForArticleDates/.test(processRoute), 'New OCR article creation must stale the related rollup month.');
assert(/markMonthlyRollupsStaleForArticleDates/.test(reprocessRoute), 'Reprocess must stale the related rollup month.');
assert(/buildMonthlyRollupContext/.test(chatJobRun), 'Chat job run must be able to use monthly rollup context.');
assert(/monthly_rollup_used/.test(chatJobRun), 'Chat job result must expose monthly rollup usage metadata.');
assert(/monthly_rollups/.test(monthlyContext) && /status', 'ready'/.test(monthlyContext), 'Monthly rollup context should use ready rollups.');

console.log('verify-rollup-logic: ok');
