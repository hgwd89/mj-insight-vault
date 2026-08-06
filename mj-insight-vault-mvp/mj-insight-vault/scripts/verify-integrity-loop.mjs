import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const qualityGate = read('lib/chatAnalysisQualityGate.ts');
const formalMetadata = read('supabase/migrations/20260806095000_harden_formal_report_metadata.sql');
const formalGateV2 = read('supabase/migrations/20260806095500_enforce_formal_gate_v2.sql');
const reportReclassify = read('supabase/migrations/20260806101200_reclassify_reports_with_formal_gate_v2.sql');
const monthlyContext = read('lib/monthlyRollupContext.ts');
const monthlyWorker = read('lib/monthlyRollupWorker.ts');
const monthlyRoute = read('app/api/rollups/monthly/route.ts');
const monthlyWorkerRoute = read('app/api/rollups/monthly/worker/route.ts');
const monthlyMigration = read('supabase/migrations/20260806100000_add_monthly_rollup_worker.sql');
const monthlyRetryStop = read('supabase/migrations/20260806101400_stop_automatic_failed_rollup_retries.sql');
const monthlyPage = read('app/rollups/page.tsx');

assert(/formal_gate_v2/.test(qualityGate), 'Formal quality gate must be versioned.');
assert(/raw_before_enrichment/.test(qualityGate), 'Formal validation must run before display enrichment.');
assert(/existingRawGate/.test(qualityGate), 'Repeated quality enhancement must reuse the original raw gate.');
assert(/not_provisional/.test(qualityGate), 'Provisional output must never pass the formal gate.');
assert(/synthetic_repair/.test(qualityGate), 'Display repairs must be explicitly marked synthetic.');
assert(/!bool\(item\.synthetic_repair\)/.test(qualityGate), 'Synthetic evidence must be excluded from formal validation.');
assert(!/coverage_complete_or_flagged/.test(qualityGate), 'Merely flagging provisional coverage must not pass formal validation.');
assert(/raw_evidence_matrix/.test(qualityGate) && /raw_refutation_audit/.test(qualityGate), 'Raw evidence and refutation checks are required.');
assert(/raw_research_needs/.test(qualityGate) && /raw_negative_space/.test(qualityGate), 'Raw research and negative-space checks are required.');

assert(/not provisional/.test(formalMetadata) || /not provisional/.test(formalGateV2), 'Database formal classification must reject provisional reports.');
assert(/formal_report_gate_version_missing/.test(formalGateV2), 'Database must reject old full-corpus writers without gate v2.');
assert(/gate_version = 'formal_gate_v2'/.test(formalGateV2), 'Database must require formal_gate_v2.');
assert(/validation_mode = 'raw_before_enrichment'/.test(formalGateV2), 'Database must require raw-before-enrichment validation.');
assert(/fallback_used/.test(formalGateV2), 'Database formal classification must reject fallback output.');
assert(/update public\.chat_reports/.test(reportReclassify), 'Legacy reports must be reclassified after gate v2 is installed.');

assert(/validatedReady/.test(monthlyContext), 'Monthly report context must validate ready rows.');
assert(/invalid_ready_months/.test(monthlyContext), 'Invalid legacy ready rows must be exposed.');
assert(/rollup_analysis_is_validated/.test(monthlyContext), 'Monthly context must require validated rollup metadata.');
assert(/source_article_ids/.test(monthlyContext), 'Monthly context must verify source coverage count.');
assert(/legacySelect/.test(monthlyContext), 'Monthly context must tolerate code/database rollout order.');

assert(/sourceFingerprint/.test(monthlyWorker) && /compactArticle\(article\)/.test(monthlyWorker), 'Monthly fingerprint must include article content.');
assert(/claim_next_monthly_rollup/.test(monthlyWorker), 'Monthly work must be claimed atomically.');
assert(/eq\('lease_token', token\)/.test(monthlyWorker), 'Monthly writes must retain lease ownership.');
assert(/refreshed\.fingerprint !== fingerprint/.test(monthlyWorker), 'Source changes must be detected before ready.');
assert(/insufficient grounded evidence/.test(monthlyWorker), 'Ungrounded chunk summaries must be rejected.');
assert(/No extractive fallback was accepted as formal/.test(monthlyWorker), 'Monthly worker must not accept extractive fallback.');
assert(/maxDuration = 240/.test(monthlyWorkerRoute), 'Monthly worker endpoint must be bounded below 300 seconds.');
assert(/kickMonthlyRollupWorker/.test(monthlyWorkerRoute), 'Completed worker steps must chain the next bounded step.');
assert(/maxDuration = 60/.test(monthlyRoute) && !/generateMonthlyRollup/.test(monthlyRoute), 'Public monthly route must enqueue only.');

assert(/for update skip locked/.test(monthlyMigration), 'Monthly worker claim must use SKIP LOCKED.');
assert(/lease_expires_at/.test(monthlyMigration), 'Monthly worker must recover expired leases.');
assert(/mj_monthly_rollup_worker/.test(monthlyMigration), 'Monthly server-side cron is required.');
assert(/status in \('queued', 'stale', 'provisional'\)/.test(monthlyRetryStop), 'Automatic monthly claims must include only resumable states.');
assert(!/status in \('queued', 'stale', 'failed', 'provisional'\)/.test(monthlyRetryStop), 'Permanent failed rollups must not be auto-claimed forever.');
assert(/active\.status = 'running'/.test(monthlyRetryStop), 'Monthly worker must enforce a global active-step concurrency cap.');
assert(/queued_count/.test(monthlyRoute) && /generated_count: 0/.test(monthlyRoute), 'Queue acceptance must not be reported as generation completion.');
assert(/完了ではありません/.test(monthlyPage), 'UI must explicitly distinguish queued from completed.');
assert(/pending_months/.test(monthlyPage) && /10_000/.test(monthlyPage), 'UI must poll pending monthly work.');

console.log('verify-integrity-loop: ok');
