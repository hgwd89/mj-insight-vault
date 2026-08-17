import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'lib/articleInventoryWorkerV5Consensus.ts'), 'utf8');
const retryRoute = fs.readFileSync(path.join(root, 'app/api/internal/inventory-majority-n-retry/route.ts'), 'utf8');
const migrationDir = path.join(root, 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationDir).filter((name) => name.endsWith('_add_inventory_majority_n_targeted_retry.sql'));

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

assert(retryRoute.includes("process.env.VERCEL_ENV !== 'production'"), 'Targeted retry route must be production-only.');
assert(retryRoute.includes("supabaseAdmin.rpc('prepare_inventory_majority_n_retry_v1')"), 'Targeted retry route must obtain only DB-verified eligible jobs.');
assert(retryRoute.includes('runArticleInventoryWorkerV7GroundedOrchestratorStep(jobId)'), 'Targeted retry route must execute V7 with the exact prepared job id.');
assert(!retryRoute.includes('runArticleInventoryWorkerV7GroundedOrchestratorStep()'), 'Targeted retry route must never call the generic Inventory drain.');
assert(/export const maxDuration = 300/.test(retryRoute), 'Targeted retry route must retain the bounded 300-second duration budget.');

assert(migrationNames.length === 1, `Exactly one targeted majority-N retry migration is required; found ${migrationNames.length}.`);
const sql = fs.readFileSync(path.join(migrationDir, migrationNames[0]), 'utf8');
assert(sql.includes('prepare_inventory_majority_n_retry_v1'), 'Database must expose the targeted majority-N prepare RPC.');
assert(sql.includes("j.error_message='One-model-only visual article has no independent support.'"), 'Prepare RPC must be pinned to the exact review reason.');
assert(sql.includes("j.status='needs_review'"), 'Prepare RPC must only requeue needs_review jobs.');
assert(sql.includes("j.inventory_version='page_article_inventory_v4_recovered_ocr'"), 'Prepare RPC must be pinned to the recovered OCR Inventory version.');
assert(sql.includes("freeze_gate_v2='passed'"), 'Prepare RPC must require the current formal freeze.');
assert(sql.includes("p.pass_kind='mapper' and p.model='gpt-4.1'"), 'Prepare RPC must require the original mapper receipt.');
assert(sql.includes("p.pass_kind='critic' and p.model='gpt-4o'"), 'Prepare RPC must require the independent critic receipt.');
assert(sql.includes("p.pass_kind='adjudicator' and p.model='gpt-5.6-sol'"), 'Prepare RPC must require the independent GPT-5.6-sol adjudicator receipt.');
assert(sql.includes("a.group_kind='article'"), 'Prepare RPC must identify a concrete singleton article group.');
assert(sql.includes("n.group_kind='non_article'"), 'Prepare RPC must require explicit non-article groups from both other passes.');
assert(sql.includes('bi=any(n.block_indices)'), 'Prepare RPC must require every singleton block to be covered by each opposing non-article partition.');
assert(sql.includes('source_region_materialization_receipts_v6'), 'Prepare RPC must fail closed when downstream materialization exists.');
assert(sql.includes('source_page_article_inventory_mappings_v2'), 'Prepare RPC must fail closed when mappings exist.');
assert(sql.includes('source_page_inventory_visual_exclusions_v1'), 'Prepare RPC must exclude semantic/override state that requires specialized repair.');
assert(sql.includes("set status='queued'"), 'Prepare RPC must only move the selected job back to queued without deleting pass evidence.');
assert(!sql.includes('delete from public.source_page_article_inventory_pass_runs_v1'), 'Targeted retry must preserve all three pass receipts.');
assert(!sql.includes('delete from public.source_page_article_inventory_groups_v1'), 'Targeted retry must preserve all partition groups.');
assert(/for update of j skip locked/i.test(sql), 'Targeted retry selection must be concurrency-safe.');
assert(/revoke all on function public\.prepare_inventory_majority_n_retry_v1/.test(sql), 'Targeted retry RPC must be hidden from public roles.');
assert(/grant execute on function public\.prepare_inventory_majority_n_retry_v1/.test(sql) && /to service_role/.test(sql), 'Only service_role may execute targeted retry RPC.');

// No-op source touch to retrigger the canonical Vercel Preview after the prior rate-limit failure.
console.log('verify-inventory-majority-n-singletons: ok');
