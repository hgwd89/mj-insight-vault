import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const route = fs.readFileSync(path.join(root, 'app/api/reports/[id]/route.ts'), 'utf8');

function assertIncludes(expected, label) {
  if (!route.includes(expected)) throw new Error(`${label}: missing ${JSON.stringify(expected)}`);
}

assertIncludes("report.is_formal_report === true", 'formal evidence route must detect formal reports');
assertIncludes("formal_corpus_articles_v1", 'formal evidence route must use the verified formal corpus');
assertIncludes("formal report evidence is no longer present in formal_corpus_articles_v1", 'formal evidence route must fail closed if saved evidence leaves the formal corpus');
assertIncludes("evidence_source: formalReport ? 'formal_corpus_articles_v1' : 'articles'", 'response metadata must identify the evidence source');
assertIncludes('formal_corpus_only: formalReport', 'response metadata must expose formal-corpus-only status');

const formalBranch = route.slice(route.indexOf("const evidenceSource = formalReport"), route.indexOf('const result = await supabaseAdmin'));
if (!formalBranch.includes("formalReport ? 'formal_corpus_articles_v1' : 'articles'")) {
  throw new Error('formal report evidence must not fall back to mutable raw articles');
}

console.log('report evidence link v34 verification passed');
