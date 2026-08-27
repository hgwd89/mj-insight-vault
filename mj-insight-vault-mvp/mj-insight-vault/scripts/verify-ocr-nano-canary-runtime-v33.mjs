import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const v32 = read('supabase/migrations/20260827160000_scope_nano_v18_canary_runtime_v32.sql');
const v33 = read('supabase/migrations/20260827170000_harden_nano_canary_runtime_v33.sql');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(v32.includes('activate_ocr_consensus_canary_cohort_v32'), 'validated v32 activation function missing');
assert(v32.includes('restart_ocr_consensus_canaries_v32'), 'validated v32 restart function missing');
assert(v32.includes('ocr_consensus_canary_cohorts_v26'), 'v32 must remain bound to durable v26 cohorts');

assert(/revoke\s+insert\s*,\s*update\s*,\s*delete\s+on\s+table\s+public\.ocr_consensus_canary_runtime_v32\s+from\s+service_role/i.test(v33), 'service_role runtime writes must be revoked');
assert(/grant\s+select\s+on\s+table\s+public\.ocr_consensus_canary_runtime_v32\s+to\s+service_role/i.test(v33), 'service_role must retain read-only runtime visibility');
assert(!/grant\s+(?:select\s*,\s*)?(?:insert|update|delete)[^;]*ocr_consensus_canary_runtime_v32[^;]*service_role/i.test(v33), 'v33 must not grant service_role direct runtime mutation');
assert(/grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+table\s+public\.ocr_consensus_canary_runtime_v32\s+to\s+postgres/i.test(v33), 'postgres owner path must remain available for SECURITY DEFINER control functions');

console.log('verify-ocr-nano-canary-runtime-v33: passed');
