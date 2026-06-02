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

assert(/MarkdownText/.test(reportPage) && /articleLabel/.test(reportPage), 'Report detail page must render article links readably.');
assert(/internalArticleHref/.test(markdown), 'Markdown article text renderer must constrain article links to internal article routes.');
assert(!/OCR照合メモ/.test(prompt), 'Report prompt must not ask reports to include OCR reference memo blocks.');

console.log('verify-report-shape: ok');
