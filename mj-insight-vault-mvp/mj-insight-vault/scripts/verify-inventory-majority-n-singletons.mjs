import fs from 'node:fs';
import path from 'node:path';
const source = fs.readFileSync(path.join(process.cwd(), 'lib/articleInventoryWorkerV5Consensus.ts'), 'utf8');
function assert(condition, message) { if (!condition) throw new Error(message); }
assert(source.includes('const rejectedSingletonRoots = new Set<number>()'), 'Consensus must track explicitly rejected singleton components.');
assert(source.includes("g.pass_kind === pass && g.group_kind === 'non_article'"), 'A singleton may be rejected only against explicit non-article groups from each other pass.');
assert(source.includes('singleton.block_indices.every((blockIndex) => nonArticleGroups.some((g) => g.block_indices.includes(blockIndex)))'), 'Both other passes must label every singleton block non-article.');
assert(source.includes("if (!contradictedByBothOtherPasses) throw new ReviewRequiredError('One-model-only visual article has no independent support.')"), 'Any unresolved singleton must still fail closed.');
assert(source.includes('const roots = allRoots.filter((root) => !rejectedSingletonRoots.has(root))'), 'Rejected singleton components must not become formal articles.');
assert(source.includes('Rejected single-model article ${label} unexpectedly received majority blocks.'), 'Rejected singleton labels must never win majority consensus.');
assert(source.includes('rejected_evidence=${rejectedEvidence}'), 'Final non-article consensus must preserve rejection provenance.');
assert(source.includes("if (ranked[0][1] < 2) throw new ReviewRequiredError(`Three-way visual tie at block ${b.block_index}.`)"), 'Three-way ties must remain fail-closed.');
assert(source.includes('if (options.length > 1 && options[0] - options[1] < 0.08)'), 'Ambiguous correspondence must remain fail-closed.');
const safe = (ownBlocks, otherPasses) => otherPasses.every((groups) => ownBlocks.every((bi) => groups.some((g) => g.kind === 'N' && g.blocks.includes(bi))));
assert(safe([1,2], [[{kind:'N',blocks:[1,2,3]}],[{kind:'N',blocks:[1,2]}]]), 'Two explicit N votes must reject one article vote.');
assert(!safe([1,2], [[{kind:'N',blocks:[1,2]}],[{kind:'A',blocks:[1,2]}]]), 'One N and one article vote must remain unresolved.');
assert(!safe([1,2], [[{kind:'N',blocks:[1]}],[{kind:'N',blocks:[1,2]}]]), 'Partial N coverage must remain unresolved.');
console.log('verify-inventory-majority-n-singletons: ok');
