import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'app/api/reports/[id]/route.ts'), 'utf8');

function assertIncludes(expected, label) {
  if (!route.includes(expected)) throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
}

assertIncludes("report.is_formal_report === true", 'formal evidence route must detect formal reports');
assertIncludes(".from('formal_corpus_articles_v1')", 'formal evidence route must use the verified formal corpus');
assertIncludes("formal report evidence is no longer present in formal_corpus_articles_v1", 'formal evidence route must fail closed if saved evidence leaves the formal corpus');
assertIncludes("evidence_source: formalReport ? 'formal_corpus_articles_v1' : 'articles'", 'response metadata must identify the evidence source');
assertIncludes('formal_corpus_only: formalReport', 'response metadata must expose formal-corpus-only status');

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

console.log('report evidence link v34 verification passed');
