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
  'google_v16_sol_length_ratio',
  'google_legacy_sol_length_ratio',
  'current_v16_sol_length_ratio',
  'current_legacy_sol_length_ratio',
  'current_v16_sol_similarity',
  'current_legacy_sol_similarity',
  'v16_legacy_sol_similarity',
  'current_v16_sol_numeric_equal',
  'current_legacy_sol_numeric_equal',
  'v16_legacy_sol_numeric_equal',
  'current_sol_terra_proper_noun_agreement',
  'v16_sol_terra_proper_noun_agreement',
  'legacy_sol_terra_proper_noun_agreement',
  'current_sol_unreadable_rate',
  'current_terra_unreadable_rate',
  'v16_sol_unreadable_rate',
  'legacy_sol_unreadable_rate',
  'v16_google_sol_similarity',
  'legacy_google_sol_similarity',
  'v16_google_sol_numeric_equal',
  'legacy_google_sol_numeric_equal',
  'public.normalize_ocr_consensus_text_v2',
  'public.ocr_numeric_tokens_v2',
  'google_preview',
  'current_sol_preview',
  'current_terra_preview',
  'current_canonical_preview',
  'v16_sol_preview',
  'v16_terra_preview',
  'legacy_sol_preview',
  'legacy_terra_preview',
  'revoke all on public.ocr_canary_fidelity_v22 from public, anon, authenticated',
  'grant select on public.ocr_canary_fidelity_v22 to service_role'
]) {
  assert(sql.includes(invariant), `OCR canary fidelity invariant missing: ${invariant}`);
}

assert(!/create\s+or\s+replace\s+function\s+public\.decide_ocr_consensus_article_v11/i.test(sql), 'Fidelity diagnostics must not replace the OCR decision function.');
assert(!/0\.9[0-46]|0\.8[0-7]/.test(sql), 'Fidelity diagnostics must not introduce weakened OCR acceptance thresholds.');
assert(!/insert\s+into\s+public\.article_ocr_verifications_v11/i.test(sql), 'Fidelity diagnostics must not write canonical OCR receipts.');
assert(!/update\s+public\.ocr_consensus_decisions_v11/i.test(sql), 'Fidelity diagnostics must not mutate OCR decisions.');

console.log('verify-ocr-canary-fidelity-v22: ok');