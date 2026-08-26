import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const auditPath = path.join(root, 'scripts', 'audit-verified-pipeline-ddl-drift.mjs');
const exportPath = path.join(root, 'scripts', 'sql', 'export-verified-pipeline-ddl.sql');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const audit = fs.readFileSync(auditPath, 'utf8');
const sql = fs.readFileSync(exportPath, 'utf8');

function parsePinnedArray(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = audit.match(new RegExp(`const\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.sort\\(\\);`));
  assert(match, `Pinned manifest array not found: ${name}`);
  return [...match[1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]).sort();
}

function parseSqlTarget(startMarker, endMarker) {
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `SQL target section not found: ${startMarker}`);
  return [...sql.slice(start, end).matchAll(/\('([a-zA-Z0-9_]+)'\)/g)].map((m) => m[1]).sort();
}

function sameSet(actual, expected, label) {
  assert(actual.length === expected.length, `${label} count mismatch: ${actual.length} != ${expected.length}`);
  for (let i = 0; i < actual.length; i += 1) {
    assert(actual[i] === expected[i], `${label} mismatch at ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

const pinnedFunctions = parsePinnedArray('knownMissingFunctions');
const pinnedRelations = parsePinnedArray('knownMissingRelations');
const sqlFunctions = parseSqlTarget('with target_functions(name) as (', 'target_relations(name) as (');
const sqlRelations = parseSqlTarget('target_relations(name) as (', 'function_export as (');

sameSet(sqlFunctions, pinnedFunctions, 'export function manifest');
sameSet(sqlRelations, pinnedRelations, 'export relation manifest');
assert(pinnedFunctions.length === 38, `Expected 38 pinned functions, got ${pinnedFunctions.length}`);
assert(pinnedRelations.length === 16, `Expected 16 pinned relations, got ${pinnedRelations.length}`);

const withoutComments = sql.replace(/^\s*--.*$/gm, '');
const forbiddenMutation = /\b(insert|update|delete|alter|drop|truncate|grant|revoke|call|copy|do)\b/i;
assert(!forbiddenMutation.test(withoutComments), 'Authoritative DDL export SQL must remain read-only.');
assert((withoutComments.match(/;/g) || []).length === 1, 'Authoritative DDL export must remain a single read-only statement.');

for (const invariant of [
  'pg_get_functiondef',
  'pg_get_function_identity_arguments',
  'pg_get_function_arguments',
  'pg_get_function_result',
  'security_definer',
  'p.proconfig',
  'p.proacl',
  'information_schema.routine_privileges',
  'pg_get_viewdef',
  'pg_get_constraintdef',
  'pg_get_indexdef',
  'pg_get_triggerdef',
  'pg_policies',
  'c.relrowsecurity',
  'c.relforcerowsecurity',
  'c.relacl',
  'information_schema.role_table_grants',
  'current_database()',
  "current_setting('server_version')",
  'missing_function_count',
  'missing_relation_count'
]) {
  assert(sql.includes(invariant), `Authoritative DDL export invariant missing: ${invariant}`);
}

console.log('verify-verified-pipeline-ddl-export: ok (38 functions, 16 relations, read-only)');
