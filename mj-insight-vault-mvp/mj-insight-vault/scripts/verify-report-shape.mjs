import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const prompt = read('lib/reportPrompt.ts');
const qualityGate = read('lib/chatAnalysisQualityGate.ts');
const no160 = read('lib/chatRouteNo160.ts');
const jobRun = read('app/api/chat/jobs/[id]/run/route.ts');
const jobStatus = read('app/api/chat/jobs/[id]/route.ts');
const reportPage = read('app/reports/[id]/page.tsx');
const markdown = read('components/MarkdownArticleText.tsx');
const chatPanel = read('components/ChatPanel.tsx');
const fullCorpusGuard = read('lib/chatRouteFullCorpusGuard.ts');
const monthlyRollups = read('lib/monthlyRollups.ts');
const monthlyContext = read('lib/monthlyRollupContext.ts');
const reportSafety = read('lib/reportSafety.ts');
const reportsRoute = read('app/api/reports/route.ts');
const reportDetailRoute = read('app/api/reports/[id]/route.ts');
const reportFollowupRoute = read('app/api/reports/[id]/chat/route.ts');
const chatCore = read('lib/chatRouteCore.ts');
const schemaReconcile = read('supabase/migrations/20260729000000_reconcile_report_analysis_schema.sql');
const schema = read('supabase/schema.sql');

for (const key of [
  'answer_text',
  'coverage_diagnosis',
  'hypothesis_comparison',
  'evidence_matrix',
  'refutation_audit',
  'what_can_be_said',
  'what_cannot_be_said',
  'research_need',
  'quality_score'
]) {
  assert(prompt.includes(key), `Report prompt must require ${key}.`);
}

assert(/A = Direct evidence/.test(prompt) && /Noise = advertising/.test(prompt), 'Evidence strength labels A/B/C/D/Noise are missing.');
assert(/UUID-only evidence is forbidden/.test(prompt), 'Report prompt must forbid UUID-only evidence in answer_text.');
assert(/Do not propose product development/.test(prompt), 'Report prompt must keep output focused on research themes.');

assert(/hasClickableArticleLink/.test(qualityGate), 'Quality gate must check clickable article links.');
assert(/refutationFallback/.test(qualityGate), 'Quality gate must backfill refutation audit.');
assert(/evidenceFallback/.test(qualityGate), 'Quality gate must backfill evidence matrix.');
assert(/enhanceChatAnalysisResult/.test(no160), 'Direct chat route must run the quality gate.');
assert(/enhanceChatAnalysisResult/.test(jobRun), 'Chat job route must run the quality gate.');
assert(/reasoning_effort: 'low'/.test(no160), 'GPT-5 report generation must reserve output budget by lowering reasoning effort.');
assert(/OPENAI_FINAL_FALLBACK_MODEL \|\| 'gpt-4\.1-mini'/.test(no160), 'Report fallback must use a non-reasoning model by default.');
assert(/reasoning_tokens/.test(no160) && /finish_reason/.test(no160), 'Empty report diagnostics must retain finish reason and reasoning token usage.');
assert(/Monthly rollup vs evidence article discipline/.test(no160), 'Monthly rollup reports must define a strict rollup/evidence role split.');
assert(/articles_for_citation_and_linking_only/.test(no160), 'Monthly rollup reports must label selected articles as citation-only input.');
assert(/insight_source: 'monthly_rollup_context_above'/.test(no160), 'Monthly rollup reports must identify rollups as the insight source.');
assert((no160.match(/rollupEvidenceDiscipline\(monthlyUsed\)/g) || []).length >= 2, 'Primary and fallback report prompts must enforce rollup evidence discipline.');
assert(/EVIDENCE_TEXT_LIMIT = 720/.test(no160), 'Evidence excerpts must retain enough article text for specific report claims.');
assert(/MIN_UNDATED_EVIDENCE_TEXT = 500/.test(no160), 'Thin undated evidence must have an explicit minimum text threshold.');
assert(/filtered\.length >= max \? filtered : articles/.test(no160), 'Evidence noise filtering must fall back when it would exhaust candidates.');
assert(/evidence_noise_guard/.test(no160), 'Report coverage metadata must expose the evidence noise guard.');

assert(/MarkdownArticleText/.test(reportPage) && /articleLabel/.test(markdown), 'Report detail page must render article links readably.');
assert(/internalArticleHref/.test(markdown), 'Markdown article text renderer must constrain article links to internal article routes.');
assert(!/OCR照合メモ/.test(prompt), 'Report prompt must not ask reports to include OCR reference memo blocks.');
assert(/report_requirements/.test(chatPanel), 'ChatPanel must send internal report requirements separately from query.');
assert(/正式レポート未生成/.test(chatPanel) && /href="\/corpus-scans"/.test(chatPanel), 'ChatPanel must show a clear blocked-state path when full corpus reading is incomplete.');
assert(!/query: buildReportQuery/.test(chatPanel), 'ChatPanel must not persist internal report requirements inside user query.');
assert(!/full_corpus_gate: 'provisional'/.test(fullCorpusGuard), 'Full-corpus gate failure must not degrade into provisional report generation.');
assert(!/縮退分析/.test(fullCorpusGuard), 'Full-corpus gate failure must not run degraded report analysis.');
assert(/report: null/.test(fullCorpusGuard) && /full_corpus_gate_failed/.test(fullCorpusGuard), 'Full-corpus diagnostic must not be saved as a normal chat report.');
assert(/extractive fallback is not valid as a formal monthly rollup/.test(monthlyRollups), 'Extractive monthly fallback must not be marked as formal ready context.');
assert(/isExtractiveFallback/.test(monthlyContext), 'Monthly rollup context must exclude extractive fallback rows.');
assert(/full_corpus_gate/.test(qualityGate), 'Quality gate must check full_corpus_gate for formal all/category reports.');
assert(/no_emergency_fallback/.test(qualityGate), 'Quality gate must fail emergency fallback reports.');
assert(/extractiveFallbackRollup/.test(qualityGate), 'Quality gate must distinguish extractive fallback rollups from normal fallback model generation.');
assert(/return Boolean\(job\.report_id\)/.test(jobStatus), 'Chat job status must not recover finished failed jobs as completed without a report_id.');

assert(/sanitizeReportText/.test(reportSafety) && /sanitizeJson/.test(reportSafety), 'Report safety boundary must sanitize text and recursively remove internal keys.');
assert(/sanitizeReportForDisplay/.test(reportsRoute) && /sanitizeReportForDisplay/.test(reportDetailRoute), 'Report list and detail APIs must sanitize persisted reports before returning them.');
assert(/safeAnswerEnvelope/.test(reportFollowupRoute) && reportFollowupRoute.includes('return Response.json({ answer: safeAnswer'), 'Report follow-up API must sanitize both persisted and returned answers.');
assert(/sanitizeReportForDisplay/.test(chatCore) && /answer_json: safeAnswer/.test(chatCore), 'Legacy report save path must pass through the same storage safety boundary.');
assert(/formal_report_quality_gate_failed/.test(no160) && /answer_json: safeAnswer/.test(no160), 'Formal report save must stop on quality-gate failure and persist only sanitized output.');
assert(/qualityBlocked/.test(jobRun) && /stage: qualityBlocked/.test(jobRun) && jobRun.includes('qualityBlocked ? 409'), 'Job runner must expose quality-gate blocks as a retryable blocked state.');
assert(/drop trigger if exists trg_auto_complete_chat_job_when_report_saved/.test(schemaReconcile), 'Schema reconciliation must remove the hidden job auto-completion trigger.');
assert(/create view public.analysis_readiness_view/.test(schemaReconcile), 'Schema reconciliation must define the readiness view used by analysis operations.');
assert(/enable row level security/.test(schemaReconcile) && /revoke all on table/.test(schemaReconcile), 'Corpus-analysis tables must not remain publicly readable.');
assert(/report_kind text not null default 'provisional'/.test(schema) && /is_formal_report boolean not null default false/.test(schema), 'Canonical schema must persist report verification metadata.');
assert(/sanitize_report_json/.test(schemaReconcile) && /legacy_unverified/.test(schemaReconcile), 'Schema reconciliation must sanitize and classify legacy report rows.');
assert(/report_kind: 'formal'/.test(no160) && /full_corpus_verified/.test(no160), 'Formal report saves must persist explicit verification metadata.');
assert(/report_kind: 'provisional'/.test(chatCore) && /provisional_unverified/.test(chatCore), 'Legacy/focused report saves must remain explicitly provisional.');
assert(/report_kind: 'followup'/.test(reportFollowupRoute) && /derived_followup/.test(reportFollowupRoute), 'Follow-up reports must not be mislabeled as formal reports.');
assert(/security_invoker/.test(schemaReconcile) && /revoke all on public\.corpus_scan_gate_view/.test(schemaReconcile), 'Analysis views must not bypass RLS for public roles.');

console.log('verify-report-shape: ok');
