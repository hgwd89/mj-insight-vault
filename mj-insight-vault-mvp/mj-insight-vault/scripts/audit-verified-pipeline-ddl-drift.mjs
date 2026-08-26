import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const libDir = path.join(root, 'lib');
const migrationDir = path.join(root, 'supabase', 'migrations');

const workerFiles = fs.readdirSync(libDir)
  .filter((name) => /^verified.*Worker\.ts$/i.test(name))
  .sort();

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

for (const file of workerFiles) {
  const source = fs.readFileSync(path.join(libDir, file), 'utf8');
  for (const match of source.matchAll(/\.rpc\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g)) {
    addOwner(rpcOwners, match[1], file);
  }
  for (const match of source.matchAll(/\.from\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g)) {
    addOwner(relationOwners, match[1], file);
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

function owners(map, names) {
  return Object.fromEntries(names.map((name) => [name, [...map.get(name)].sort()]));
}

const report = {
  worker_files: workerFiles,
  rpc_count: rpcNames.length,
  relation_count: relationNames.length,
  missing_functions: missingFunctions,
  missing_function_grants: missingFunctionGrants,
  missing_relations: missingRelations,
  missing_function_owners: owners(rpcOwners, missingFunctions),
  missing_relation_owners: owners(relationOwners, missingRelations)
};

console.log('VERIFIED_PIPELINE_DDL_AUDIT=' + JSON.stringify(report));

// Report-only first pass. Once the current production-only gap is measured from CI,
// pin the exact known gap and make any expansion fail closed.
