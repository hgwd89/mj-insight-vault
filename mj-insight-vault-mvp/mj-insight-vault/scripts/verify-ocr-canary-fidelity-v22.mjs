import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sql = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260826183500_add_ocr_canary_fidelity_v22.sql'),
  'utf8'
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const invariant of [
  'with (security_invoker = true)',
  'from public.ocr_canary_method_comparison_v19 c',
  'google_sol_length_ratio',
  'sol_terra_length_ratio',
  'current_sol_unreadable_rate',
  'current_terra_unreadable_rate',
  'google_preview',
  'current_sol_preview',
  'current_terra_preview',
  'v16_sol_preview',
  'legacy_sol_preview',
  'revoke all on public.ocr_canary_fidelity_v22 from public, anon, authenticated',
  'grant select on public.ocr_canary_fidelity_v22 to service_role'
]) {
  assert(sql.includes(invariant), `OCR canary fidelity invariant missing: ${invariant}`);
}

assert(!/create\s+or\s+replace\s+function\s+public\.decide_ocr_consensus_article_v11/i.test(sql), 'Fidelity diagnostics must not replace the OCR decision function.');
assert(!/0\.9[0-46]|0\.8[0-7]/.test(sql), 'Fidelity diagnostics must not introduce weakened OCR acceptance thresholds.');
assert(!/insert\s+into\s+public\.article_ocr_verifications_v11/i.test(sql), 'Fidelity diagnostics must not write canonical OCR receipts.');

console.log('verify-ocr-canary-fidelity-v22: ok');
