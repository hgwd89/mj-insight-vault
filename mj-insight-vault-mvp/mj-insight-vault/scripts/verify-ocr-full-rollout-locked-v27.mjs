import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migrationDir = path.join(root, 'supabase', 'migrations');
const migrationName = fs.readdirSync(migrationDir).find((name) => name.endsWith('_retire_ocr_consensus_generic_claim_v27.sql'));
if (!migrationName) throw new Error('V27 generic OCR claim retirement migration is missing.');
const migration = fs.readFileSync(path.join(migrationDir, migrationName), 'utf8');
const pieceWorker = fs.readFileSync(path.join(root, 'lib', 'ocrConsensusPieceWorkerV18.ts'), 'utf8');
const pieceRoute = fs.readFileSync(path.join(root, 'app', 'api', 'internal', 'ocr-consensus-piece-v18', 'route.ts'), 'utf8');
const v11Route = fs.readFileSync(path.join(root, 'app', 'api', 'internal', 'ocr-consensus-v11', 'route.ts'), 'utf8');
const v16Route = fs.readFileSync(path.join(root, 'app', 'api', 'internal', 'ocr-consensus-segment-v16', 'route.ts'), 'utf8');
const oldCanaryRoute = fs.readFileSync(path.join(root, 'app', 'api', 'internal', 'ocr-independent-canary', 'route.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A. The generic v11 claim must be unusable by service_role while rollout is locked.
assert(migration.includes('create or replace function public.claim_ocr_consensus_job_v11'), 'V27 must replace the generic v11 claim.');
assert(migration.includes("raise exception 'ocr_consensus_v11_generic_claim_retired'"), 'Generic v11 claim must fail closed.');
assert(/revoke all on function public\.claim_ocr_consensus_job_v11\(integer\) from public,anon,authenticated,service_role;/i.test(migration), 'service_role execution must be revoked from the generic v11 claim.');
assert(/grant execute on function public\.claim_ocr_consensus_job_v11\(integer\) to postgres;/i.test(migration), 'Only postgres may retain execute on the retired generic claim.');
assert(!/grant execute on function public\.claim_ocr_consensus_job_v11\(integer\) to postgres\s*,\s*service_role/i.test(migration), 'V27 must not re-grant generic claim execution to service_role.');

// B. The drain's historical kick alias must inherit the current non-canary guard.
const kickStart = migration.indexOf('create or replace function public.kick_ocr_consensus_piece_v18_canary_v1');
assert(kickStart >= 0, 'V27 must replace the historical v18 canary kick alias.');
const kickBody = migration.slice(kickStart);
assert(kickBody.includes('public.kick_ocr_consensus_piece_canary_v18()'), 'Historical kick alias must delegate to the guarded canary kick.');
assert(!kickBody.includes('net.http_post('), 'Historical kick alias must not independently bypass the guarded kick.');

// C. The only active consensus execution route is piece-v18 and it must claim canaries only.
assert(pieceWorker.includes("rpc('claim_ocr_consensus_canary_v16'"), 'Piece worker must use the canary-only claim RPC.');
assert(!pieceWorker.includes("rpc('claim_ocr_consensus_job_v11'"), 'Piece worker must never use the generic v11 claim.');
assert(pieceWorker.includes('!claim.is_canary'), 'Piece worker must independently reject a non-canary claim payload.');
assert(pieceRoute.includes('requireAppPassword(req)'), 'Piece execution route must remain authenticated.');
assert(pieceRoute.includes('runOcrConsensusPieceV18Step()'), 'Piece execution route must remain wired only to the piece worker.');
assert(!pieceRoute.includes('runOcrConsensusV11Step'), 'Piece route must not invoke the retired v11 worker.');
assert(!pieceRoute.includes('runOcrConsensusSegmentV16Step'), 'Piece route must not invoke the retired v16 worker.');

// D. Legacy POST execution entrances must remain HTTP 410, not merely undocumented.
for (const [name, route] of [['v11', v11Route], ['v16', v16Route], ['independent-canary', oldCanaryRoute]]) {
  assert(/export async function POST/.test(route), `${name} retired route must retain an explicit POST handler.`);
  assert(/status:\s*410/.test(route), `${name} POST must fail with HTTP 410.`);
  assert(/status:\s*'retired'/.test(route), `${name} POST must identify itself as retired.`);
}

// E. Repository SQL may not seed full-corpus/non-canary consensus jobs while rollout is locked.
// If a controlled canary seed exists, the INSERT statement itself must explicitly bind
// is_canary=true; absence of any INSERT is even safer.
for (const name of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql'))) {
  const text = fs.readFileSync(path.join(migrationDir, name), 'utf8');
  const inserts = [...text.matchAll(/insert\s+into\s+(?:public\.)?ocr_consensus_jobs_v11\b[\s\S]*?;/gi)].map((m) => m[0]);
  for (const statement of inserts) {
    assert(/\bis_canary\b/i.test(statement) && /\btrue\b/i.test(statement), `${name} contains an OCR consensus job INSERT that is not explicitly canary-only.`);
  }

  // No cron/migration body may invoke the retired generic claim. Ignore its own DDL,
  // grant and revoke declarations; any remaining call site is an execution bypass.
  const lines = text.split(/\r?\n/).filter((line) => line.includes('claim_ocr_consensus_job_v11('));
  for (const line of lines) {
    assert(/create or replace function|revoke all on function|grant execute on function/i.test(line), `${name} invokes retired generic claim from SQL: ${line.trim()}`);
  }
}

// F. Runtime TypeScript must not create consensus jobs directly. Full rollout later must
// be introduced as a separate release-gated operation, not an accidental .insert().
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}
for (const file of [...walk(path.join(root, 'app')), ...walk(path.join(root, 'lib'))]) {
  const text = fs.readFileSync(file, 'utf8');
  assert(!/\.from\(\s*['"]ocr_consensus_jobs_v11['"]\s*\)[\s\S]{0,400}?\.insert\s*\(/i.test(text), `${path.relative(root, file)} directly inserts OCR consensus jobs while full rollout is locked.`);
}

console.log('verify-ocr-full-rollout-locked-v27: ok (generic claim retired, guarded canary kick, legacy POSTs 410, no non-canary job creation path)');
