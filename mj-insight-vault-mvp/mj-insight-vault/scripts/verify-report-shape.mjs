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
const reportPage = read('app/reports/[id]/page.tsx');
const markdown = read('components/MarkdownArticleText.tsx');

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
assert(no160.includes('DEFAULT_WRITER_TIMEOUT_MS = 130000'), 'Writer timeout must default to 130 seconds.');
assert(no160.includes('MAX_WRITER_TIMEOUT_MS = 135000'), 'Writer timeout must remain capped at 135 seconds.');
assert(no160.includes('resolveWriterTimeoutMs(process.env.WRITER_TIMEOUT_MS)'), 'Writer timeout must support bounded environment configuration.');
assert(no160.includes('writer_diagnostics: writerDiagnostics'), 'Reports must persist additive Writer diagnostics in answer_json.');
assert(no160.includes('evidence_text_characters') && no160.includes('monthly_rollup_context_characters'), 'Writer diagnostics must record bounded input sizes.');
assert(qualityGate.includes('const answer = isRecord(result.answer) ? { ...result.answer } : {}'), 'Quality gate must preserve additive answer_json fields.');
assert(no160.includes('Math.min(MAX_WRITER_TIMEOUT_MS'), 'Writer timeout configuration must enforce the upper bound.');
assert(no160.includes('answer_json: enhancedAnswer'), 'Enhanced answer fields must be persisted to chat_reports.answer_json.');
assert(no160.includes('elapsed_ms') && no160.includes('user_payload_characters'), 'Writer diagnostics must retain elapsed time and total user payload size.');
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

console.log('verify-report-shape: ok');
