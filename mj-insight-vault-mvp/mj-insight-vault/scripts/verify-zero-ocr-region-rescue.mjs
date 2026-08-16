import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const rescue = fs.readFileSync(path.join(root, 'lib/sourcePageInventoryRegionOcrRescue.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/zero-ocr-region-recovery/route.ts'), 'utf8');
const migrationDir = path.join(root, 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationDir).filter((name) => name.endsWith('_add_zero_ocr_region_rescue_v2.sql'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(migrationNames.length === 1, `Exactly one zero OCR rescue migration is required; found ${migrationNames.length}.`);
const sql = fs.readFileSync(path.join(migrationDir, migrationNames[0]), 'utf8');

assert(route.includes("const REGION_JOB_ID = '9640ace3-1c68-436b-9e3c-eb6fe2ce812c'"), 'The rescue route must remain pinned to the one unresolved region job.');
assert(route.includes('runSourcePageInventoryRegionOcrRescueStep(REGION_JOB_ID)'), 'The dedicated route must use rescue v2, not the original single-crop worker.');
assert(/export const maxDuration = 300/.test(route), 'The bounded rescue route must keep the verified 300-second duration budget.');

for (const variant of ['supported_union_color', 'supported_union_enhanced', 'bottom_band_color', 'bottom_band_enhanced']) {
  assert(rescue.includes(`'${variant}'`), `Rescue must preserve ${variant}.`);
}
assert(rescue.includes('runDocumentOcrBatch(variants.map((variant) => variant.buffer))'), 'All rescue variants must be sent in one bounded Google Vision batch.');
assert(rescue.includes("const MIN_HINT_SIMILARITY = 0.20"), 'Rescue must require semantic agreement with the independently detected headline hint.');
assert(rescue.includes('targetBlocks.length > 0 && targetText.length >= 8 && hintSimilarity >= MIN_HINT_SIMILARITY'), 'Rescue completion must fail closed on empty or unrelated OCR.');
assert(rescue.includes("p_recovered_text: recoveredText") && rescue.includes("p_recovered_blocks: recoveredBlocks"), 'Only accepted target OCR may be persisted as recovered content.');
assert(rescue.includes('prior_attempt:') && rescue.includes('google_response_sha256: job.google_response_sha256'), 'The first failed OCR attempt must remain embedded in rescue evidence.');
assert(rescue.includes("external_calls: 1"), 'A rescue step must remain one external Vision batch call.');

assert(sql.includes('claim_source_page_inventory_region_ocr_rescue_v2'), 'Database must expose a dedicated rescue claim RPC.');
assert(/status\s*=\s*'needs_review'/.test(sql), 'Rescue claim must only accept needs_review rows.');
assert(/attempt_count\s*=\s*1/.test(sql), 'A successful first OCR attempt-to-review transition may receive only one deterministic rescue attempt.');
assert(sql.includes("error_message = 'region crop OCR returned insufficient text'"), 'Rescue must only reclaim the specific insufficient-text state.');
for (const field of ['crop_spec_sha256', 'crop_image_sha256', 'google_response_sha256', 'google_text_sha256']) {
  assert(sql.includes(`${field} is not null`), `Rescue claim must require preserved first-attempt evidence: ${field}.`);
}
assert(/for update skip locked/i.test(sql), 'Rescue claim must remain atomic and concurrency-safe.');
assert(/greatest\(300,least\(600/.test(sql), 'Rescue lease must outlive the Vision timeout and remain bounded.');
assert(/revoke all on function public\.claim_source_page_inventory_region_ocr_rescue_v2/.test(sql), 'Rescue RPC must be hidden from public roles.');
assert(/grant execute on function public\.claim_source_page_inventory_region_ocr_rescue_v2/.test(sql) && /to service_role/.test(sql), 'Only service_role may execute the rescue RPC.');

console.log('verify-zero-ocr-region-rescue: ok');
