import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'app/api/reports/[id]/route.ts'), 'utf8');
const chatRoute = fs.readFileSync(path.join(root, 'app/api/reports/[id]/chat/route.ts'), 'utf8');

function assertIncludes(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
}

for (const [source, label] of [[route, 'report evidence route'], [chatRoute, 'report chat route']]) {
  assertIncludes(source, 'function usesFormalCorpusEvidence', `${label} must centralize formal-corpus provenance detection`);
  assertIncludes(source, 'report.is_formal_report === true', `${label} must recognize primary formal reports`);
  assertIncludes(source, 'metadata.formal_corpus_only === true', `${label} must recognize saved formal-corpus follow-ups`);
  assertIncludes(source, "metadata.evidence_source === 'formal_corpus_articles_v1'", `${label} must require verified evidence provenance on saved follow-ups`);
  assertIncludes(source, '.from(\'formal_corpus_articles_v1\')', `${label} must use the verified formal corpus`);
}

assertIncludes(route, 'const formalCorpusOnly = usesFormalCorpusEvidence', 'report evidence route must bind direct and chained formal evidence');
assertIncludes(route, 'formal-corpus report evidence is no longer present in formal_corpus_articles_v1', 'formal evidence route must fail closed if saved evidence leaves the formal corpus');
assertIncludes(route, "evidence_source: formalCorpusOnly ? 'formal_corpus_articles_v1' : 'articles'", 'response metadata must identify the evidence source');
assertIncludes(route, 'formal_corpus_only: formalCorpusOnly', 'response metadata must expose formal-corpus-only status');

const formalQueries = route.match(/\.from\('formal_corpus_articles_v1'\)/g) || [];
if (formalQueries.length < 2) {
  throw new Error(`formal report evidence must have explicit verified-corpus queries for OCR and non-OCR reads; found ${formalQueries.length}`);
}

const resultStart = route.indexOf('const result = formalCorpusOnly');
const formalSource = route.indexOf(".from('formal_corpus_articles_v1')", resultStart);
const rawSource = route.indexOf(".from('articles')", resultStart);
if (resultStart < 0 || formalSource < 0 || rawSource < 0 || formalSource > rawSource) {
  throw new Error('formal-corpus report evidence branch must resolve from formal_corpus_articles_v1 before provisional raw articles');
}

assertIncludes(chatRoute, 'const formalCorpusOnly = usesFormalCorpusEvidence', 'report chat must bind direct and chained formal evidence');
assertIncludes(chatRoute, "const evidenceSource = formalCorpusOnly ? 'formal_corpus_articles_v1' : 'articles'", 'report chat must bind its evidence source explicitly');
assertIncludes(chatRoute, 'formal-corpus report chat evidence is no longer present in formal_corpus_articles_v1', 'report chat must fail closed when verified evidence is missing');
assertIncludes(chatRoute, 'parentFormalReport: formalCorpusOnly', 'follow-up report metadata must propagate formal-corpus provenance across generations');
assertIncludes(chatRoute, 'evidence_source: args.evidenceSource', 'follow-up report metadata must preserve evidence source');
assertIncludes(chatRoute, 'formal_corpus_only: args.parentFormalReport', 'saved follow-up must preserve formal-corpus-only status');
assertIncludes(chatRoute, 'formal_corpus_only: formalCorpusOnly', 'report chat response must expose formal-corpus-only status');

const chatResultStart = chatRoute.indexOf('const result = formalCorpusOnly');
const chatFormalSource = chatRoute.indexOf(".from('formal_corpus_articles_v1')", chatResultStart);
const chatRawSource = chatRoute.indexOf(".from('articles')", chatResultStart);
if (chatResultStart < 0 || chatFormalSource < 0 || chatRawSource < 0 || chatFormalSource > chatRawSource) {
  throw new Error('formal-corpus report chat must resolve verified evidence before provisional raw articles');
}

console.log('report evidence link v34 verification passed');
