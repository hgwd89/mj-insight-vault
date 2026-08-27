import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'app/api/reports/[id]/route.ts'), 'utf8');
const chatRoute = fs.readFileSync(path.join(root, 'app/api/reports/[id]/chat/route.ts'), 'utf8');

function assertIncludes(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
}

assertIncludes(route, "report.is_formal_report === true", 'formal evidence route must detect formal reports');
assertIncludes(route, ".from('formal_corpus_articles_v1')", 'formal evidence route must use the verified formal corpus');
assertIncludes(route, "formal report evidence is no longer present in formal_corpus_articles_v1", 'formal evidence route must fail closed if saved evidence leaves the formal corpus');
assertIncludes(route, "evidence_source: formalReport ? 'formal_corpus_articles_v1' : 'articles'", 'response metadata must identify the evidence source');
assertIncludes(route, 'formal_corpus_only: formalReport', 'response metadata must expose formal-corpus-only status');

const formalQueries = route.match(/\.from\('formal_corpus_articles_v1'\)/g) || [];
if (formalQueries.length < 2) {
  throw new Error(`formal report evidence must have explicit verified-corpus queries for OCR and non-OCR reads; found ${formalQueries.length}`);
}

const resultStart = route.indexOf('const result = formalReport');
const formalSource = route.indexOf(".from('formal_corpus_articles_v1')", resultStart);
const rawSource = route.indexOf(".from('articles')", resultStart);
if (resultStart < 0 || formalSource < 0 || rawSource < 0 || formalSource > rawSource) {
  throw new Error('formal report evidence branch must resolve from formal_corpus_articles_v1 before provisional raw articles');
}

assertIncludes(chatRoute, "report.is_formal_report === true", 'formal report chat must detect formal parent reports');
assertIncludes(chatRoute, "const evidenceSource = formalReport ? 'formal_corpus_articles_v1' : 'articles'", 'formal report chat must bind its evidence source explicitly');
assertIncludes(chatRoute, ".from('formal_corpus_articles_v1')", 'formal report chat must read verified evidence from formal_corpus_articles_v1');
assertIncludes(chatRoute, "formal report chat evidence is no longer present in formal_corpus_articles_v1", 'formal report chat must fail closed when verified evidence is missing');
assertIncludes(chatRoute, 'parentFormalReport: formalReport', 'follow-up report metadata must preserve parent formal status');
assertIncludes(chatRoute, 'evidenceSource', 'follow-up report metadata must preserve evidence source');
assertIncludes(chatRoute, 'formal_corpus_only: formalReport', 'formal report chat response must expose formal-corpus-only status');

const chatResultStart = chatRoute.indexOf('const result = formalReport');
const chatFormalSource = chatRoute.indexOf(".from('formal_corpus_articles_v1')", chatResultStart);
const chatRawSource = chatRoute.indexOf(".from('articles')", chatResultStart);
if (chatResultStart < 0 || chatFormalSource < 0 || chatRawSource < 0 || chatFormalSource > chatRawSource) {
  throw new Error('formal report chat must resolve verified evidence before provisional raw articles');
}

console.log('report evidence link v34 verification passed');
