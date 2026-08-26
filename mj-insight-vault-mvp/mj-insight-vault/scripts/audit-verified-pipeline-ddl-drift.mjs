import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const libDir = path.join(root, 'lib');
const migrationDir = path.join(root, 'supabase', 'migrations');

const workerFiles = fs.readdirSync(libDir)
  .filter((name) => /^verified.*Worker(?:V\d+)?\.ts$/i.test(name))
  .sort();

const sourceFiles = [
  ...workerFiles.map((name) => ({ label: `lib/${name}`, path: path.join(libDir, name) })),
  {
    label: 'app/api/internal/verified-pipeline-scheduler/route.ts',
    path: path.join(root, 'app', 'api', 'internal', 'verified-pipeline-scheduler', 'route.ts')
  }
];

const migrationFiles = fs.readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const migrationText = migrationFiles
  .map((name) => fs.readFileSync(path.join(migrationDir, name), 'utf8'))
  .join('\n');

const rpcOwners = new Map();
const relationOwners = new Map();

function addOwner(map, key, file) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(file);
}

for (const file of sourceFiles) {
  const source = fs.readFileSync(file.path, 'utf8');
  for (const match of source.matchAll(/\.rpc\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g)) {
    addOwner(rpcOwners, match[1], file.label);
  }
  for (const match of source.matchAll(/\.from\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g)) {
    addOwner(relationOwners, match[1], file.label);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasFunctionDefinition(name) {
  const n = escapeRegex(name);
  return new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${n}\\s*\\(`, 'i').test(migrationText);
}

function hasFunctionGrant(name) {
  const n = escapeRegex(name);
  return new RegExp(`grant\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${n}\\s*\\(`, 'i').test(migrationText);
}

function hasRelationDefinition(name) {
  const n = escapeRegex(name);
  return new RegExp(`create\\s+(?:or\\s+replace\\s+)?(?:table|view|materialized\\s+view)\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${n}(?:\\s|\\()`, 'i').test(migrationText);
}

const rpcNames = [...rpcOwners.keys()].sort();
const relationNames = [...relationOwners.keys()].sort();
const missingFunctions = rpcNames.filter((name) => !hasFunctionDefinition(name));
const missingFunctionGrants = rpcNames.filter((name) => hasFunctionDefinition(name) && !hasFunctionGrant(name));
const missingRelations = relationNames.filter((name) => !hasRelationDefinition(name));

// Initially measured on GitHub Actions at HEAD 68da11ff995179d136d3565486dc4a69a6e6d21a
// for the six unversioned verified workers. The audit now scans the full verified execution
// path, including versioned report workers and the scheduler route. Any newly measured gap
// must be pinned only from CI evidence, never guessed from production behavior.
// These are known production-only DDL objects and are NOT accepted as complete.
// Once authoritative production PostgreSQL is reachable, extract the exact definitions,
// reconcile them into repository migrations, and reduce both lists to zero in the same change.
const knownMissingFunctions = [
  'claim_article_classification_job_v6',
  'claim_article_embedding_job_v5',
  'claim_source_grounded_duplicate_review_job_v7',
  'claim_verified_article_review_job_v6',
  'claim_verified_theme_census_batch_v7',
  'claim_verified_theme_consolidation_job_v7',
  'claim_verified_theme_seed_chunk_job_v7',
  'complete_article_embedding_job_v5',
  'create_source_grounded_duplicate_audit_run_v6',
  'create_verified_theme_analysis_run_v7',
  'enqueue_article_classification_jobs_v6',
  'enqueue_article_embedding_jobs_v5',
  'enqueue_verified_article_review_jobs_v6',
  'enqueue_verified_theme_census_v7',
  'fail_article_classification_job_v6',
  'fail_article_embedding_job_v5',
  'fail_source_grounded_duplicate_review_job_v7',
  'fail_verified_article_review_job_v6',
  'fail_verified_theme_census_batch_v7',
  'fail_verified_theme_consolidation_job_v7',
  'fail_verified_theme_seed_chunk_job_v7',
  'finalize_source_grounded_duplicate_audit_v7',
  'get_article_classification_input_v6',
  'get_source_grounded_duplicate_review_input_v7',
  'get_verified_article_review_input_v6',
  'get_verified_theme_census_input_v7',
  'get_verified_theme_consolidation_input_v7',
  'get_verified_theme_seed_chunk_input_v7',
  'populate_source_grounded_duplicate_candidates_v6',
  'prepare_verified_theme_consolidation_v7',
  'record_verified_article_review_corpus_receipt_v7',
  'record_verified_theme_analysis_proof_v8',
  'store_article_classification_pass_v6',
  'store_source_grounded_duplicate_review_v7',
  'store_verified_article_review_pass_v6',
  'store_verified_theme_census_pass_v7',
  'store_verified_theme_consolidation_pass_v7',
  'store_verified_theme_seed_chunk_pass_v7'
].sort();

const knownMissingRelations = [
  'article_classification_quality_gate_v6',
  'article_embedding_jobs_v4',
  'article_embedding_quality_gate_v5',
  'current_verified_article_review_corpus_receipt_v7',
  'current_verified_theme_analysis_proof_v8',
  'source_grounded_duplicate_audit_runs_v5',
  'source_grounded_duplicate_gate_v6',
  'source_grounded_duplicate_review_jobs_v7',
  'verified_article_review_gate_v6',
  'verified_article_review_jobs_v6',
  'verified_theme_analysis_runs_v7',
  'verified_theme_candidate_gate_v7',
  'verified_theme_census_batches_v7',
  'verified_theme_census_gate_v7',
  'verified_theme_consolidation_jobs_v7',
  'verified_theme_seed_chunk_jobs_v7'
].sort();

function owners(map, names) {
  return Object.fromEntries(names.map((name) => [name, [...map.get(name)].sort()]));
}

function setDelta(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    unexpected: actual.filter((name) => !expectedSet.has(name)),
    resolved_without_manifest_update: expected.filter((name) => !actualSet.has(name))
  };
}

const functionDelta = setDelta(missingFunctions, knownMissingFunctions);
const relationDelta = setDelta(missingRelations, knownMissingRelations);

const report = {
  source_files: sourceFiles.map((file) => file.label),
  worker_files: workerFiles,
  rpc_count: rpcNames.length,
  relation_count: relationNames.length,
  missing_functions: missingFunctions,
  missing_function_grants: missingFunctionGrants,
  missing_relations: missingRelations,
  function_delta: functionDelta,
  relation_delta: relationDelta,
  missing_function_owners: owners(rpcOwners, missingFunctions),
  missing_relation_owners: owners(relationOwners, missingRelations)
};

console.log('VERIFIED_PIPELINE_DDL_AUDIT=' + JSON.stringify(report));

const drift = [
  ...functionDelta.unexpected,
  ...functionDelta.resolved_without_manifest_update,
  ...relationDelta.unexpected,
  ...relationDelta.resolved_without_manifest_update,
  ...missingFunctionGrants
];

if (drift.length) {
  console.error('Verified pipeline DDL drift changed. Do not guess production DDL; reconcile against authoritative PostgreSQL and update the pinned manifest in the same change.');
  process.exit(1);
}

console.log(`verified pipeline DDL drift: pinned known production-only gap (${missingFunctions.length} functions, ${missingRelations.length} relations)`);
