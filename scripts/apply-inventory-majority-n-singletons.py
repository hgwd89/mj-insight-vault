from pathlib import Path
import json

p = Path('mj-insight-vault-mvp/mj-insight-vault/lib/articleInventoryWorkerV5Consensus.ts')
s = p.read_text()
old = """  for (const ids of components.values()) if (new Set(ids.map((i) => articles[i].pass_kind)).size < 2) throw new ReviewRequiredError('One-model-only visual article has no independent support.');
  const roots = [...components.keys()].sort((a, b) => Math.min(...components.get(a)!.flatMap((i) => articles[i].block_indices)) - Math.min(...components.get(b)!.flatMap((i) => articles[i].block_indices)));
  const componentId = new Map<number, string>(); roots.forEach((r, i) => componentId.set(r, `A${i + 1}`));
  const nodeLabel = new Map<number, string>(); articles.forEach((_, i) => nodeLabel.set(i, componentId.get(find(i))!));
"""
new = """  const rejectedSingletonRoots = new Set<number>();
  const rejectedSingletonGroups: RawGroup[] = [];
  for (const [root, ids] of components.entries()) {
    const support = new Set(ids.map((i) => articles[i].pass_kind)).size;
    if (support >= 2) continue;
    if (ids.length !== 1) throw new ReviewRequiredError('One-model-only visual article has no independent support.');
    const singleton = articles[ids[0]];
    const contradictedByBothOtherPasses = PASS_KINDS.filter((pass) => pass !== singleton.pass_kind).every((pass) => {
      const nonArticleGroups = raw.filter((g) => g.pass_kind === pass && g.group_kind === 'non_article');
      return singleton.block_indices.every((blockIndex) => nonArticleGroups.some((g) => g.block_indices.includes(blockIndex)));
    });
    if (!contradictedByBothOtherPasses) throw new ReviewRequiredError('One-model-only visual article has no independent support.');
    rejectedSingletonRoots.add(root);
    rejectedSingletonGroups.push(singleton);
  }
  const allRoots = [...components.keys()].sort((a, b) => Math.min(...components.get(a)!.flatMap((i) => articles[i].block_indices)) - Math.min(...components.get(b)!.flatMap((i) => articles[i].block_indices)));
  const roots = allRoots.filter((root) => !rejectedSingletonRoots.has(root));
  const componentId = new Map<number, string>(); roots.forEach((r, i) => componentId.set(r, `A${i + 1}`));
  const rejectedId = new Map<number, string>(); allRoots.filter((root) => rejectedSingletonRoots.has(root)).forEach((r, i) => rejectedId.set(r, `R${i + 1}`));
  const nodeLabel = new Map<number, string>();
  articles.forEach((_, i) => {
    const root = find(i); const label = componentId.get(root) || rejectedId.get(root);
    if (!label) throw new ReviewRequiredError('Internal visual component label missing.');
    nodeLabel.set(i, label);
  });
"""
assert s.count(old) == 1, 'consensus singleton target drifted'
s = s.replace(old, new, 1)
old2 = """  const byIndex = new Map(blocks.map((b) => [b.block_index, b])); const out: FinalGroup[] = [];
  roots.forEach((root, idx) => {
"""
new2 = """  for (const label of rejectedId.values()) {
    if ((winners.get(label) || []).length) throw new ReviewRequiredError(`Rejected single-model article ${label} unexpectedly received majority blocks.`);
  }
  const byIndex = new Map(blocks.map((b) => [b.block_index, b])); const out: FinalGroup[] = [];
  roots.forEach((root, idx) => {
"""
assert s.count(old2) == 1, 'consensus winner invariant target drifted'
s = s.replace(old2, new2, 1)
old3 = """  const non = (winners.get('N') || []).sort((a, b) => a - b); if (non.length) out.push({ seq: out.length + 1, group_kind: 'non_article', block_indices: non, headline_anchor: '', non_article_role: 'three_pass_visual_majority_non_article', confidence: 0.99, reason: 'three-pass block-majority non-article complement' });
"""
new3 = """  const rejectedEvidence = rejectedSingletonGroups.map((g) => `${g.pass_kind}:${g.group_fingerprint}`).sort().join(',');
  const non = (winners.get('N') || []).sort((a, b) => a - b); if (non.length) out.push({ seq: out.length + 1, group_kind: 'non_article', block_indices: non, headline_anchor: '', non_article_role: 'three_pass_visual_majority_non_article', confidence: 0.99, reason: `three-pass block-majority non-article complement; rejected_single_model_articles=${rejectedSingletonGroups.length}; rejected_evidence=${rejectedEvidence}` });
"""
assert s.count(old3) == 1, 'consensus non-article provenance target drifted'
p.write_text(s.replace(old3, new3, 1))

test = Path('mj-insight-vault-mvp/mj-insight-vault/scripts/verify-inventory-majority-n-singletons.mjs')
test.write_text("""import fs from 'node:fs';
import path from 'node:path';
const source = fs.readFileSync(path.join(process.cwd(), 'lib/articleInventoryWorkerV5Consensus.ts'), 'utf8');
function assert(condition, message) { if (!condition) throw new Error(message); }
assert(source.includes('const rejectedSingletonRoots = new Set<number>()'), 'Consensus must track explicitly rejected singleton components.');
assert(source.includes(\"g.pass_kind === pass && g.group_kind === 'non_article'\"), 'A singleton may be rejected only against explicit non-article groups from each other pass.');
assert(source.includes('singleton.block_indices.every((blockIndex) => nonArticleGroups.some((g) => g.block_indices.includes(blockIndex)))'), 'Both other passes must label every singleton block non-article.');
assert(source.includes(\"if (!contradictedByBothOtherPasses) throw new ReviewRequiredError('One-model-only visual article has no independent support.')\"), 'Any unresolved singleton must still fail closed.');
assert(source.includes('const roots = allRoots.filter((root) => !rejectedSingletonRoots.has(root))'), 'Rejected singleton components must not become formal articles.');
assert(source.includes('Rejected single-model article ${label} unexpectedly received majority blocks.'), 'Rejected singleton labels must never win majority consensus.');
assert(source.includes('rejected_evidence=${rejectedEvidence}'), 'Final non-article consensus must preserve rejection provenance.');
assert(source.includes(\"if (ranked[0][1] < 2) throw new ReviewRequiredError(`Three-way visual tie at block ${b.block_index}.`)\"), 'Three-way ties must remain fail-closed.');
assert(source.includes('if (options.length > 1 && options[0] - options[1] < 0.08)'), 'Ambiguous correspondence must remain fail-closed.');
const safe = (ownBlocks, otherPasses) => otherPasses.every((groups) => ownBlocks.every((bi) => groups.some((g) => g.kind === 'N' && g.blocks.includes(bi))));
assert(safe([1,2], [[{kind:'N',blocks:[1,2,3]}],[{kind:'N',blocks:[1,2]}]]), 'Two explicit N votes must reject one article vote.');
assert(!safe([1,2], [[{kind:'N',blocks:[1,2]}],[{kind:'A',blocks:[1,2]}]]), 'One N and one article vote must remain unresolved.');
assert(!safe([1,2], [[{kind:'N',blocks:[1]}],[{kind:'N',blocks:[1,2]}]]), 'Partial N coverage must remain unresolved.');
console.log('verify-inventory-majority-n-singletons: ok');
""")
package = Path('mj-insight-vault-mvp/mj-insight-vault/package.json')
data = json.loads(package.read_text())
data['scripts']['test:inventory-majority-n'] = 'node scripts/verify-inventory-majority-n-singletons.mjs'
current = data['scripts']['test:local']
if 'npm run test:inventory-majority-n' not in current:
    data['scripts']['test:local'] = current + ' && npm run test:inventory-majority-n'
package.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
