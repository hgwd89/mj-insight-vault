import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const rescue = fs.readFileSync(path.join(root, 'lib/sourcePageInventoryRegionOcrRescue.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'app/api/internal/zero-ocr-region-recovery/route.ts'), 'utf8');
const resumeRoute = fs.readFileSync(path.join(root, 'app/api/internal/zero-ocr-inventory-resume/route.ts'), 'utf8');
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

assert(resumeRoute.includes("const INVENTORY_JOB_ID = '33abde71-6eca-485c-94bb-51205395c476'"), 'The inventory resume route must remain pinned to the single recovered promotional OCR case.');
assert(resumeRoute.includes('runArticleInventoryWorkerV7GroundedOrchestratorStep(INVENTORY_JOB_ID)'), 'The inventory resume route must pass only the pinned job ID to V7.');
assert(!resumeRoute.includes('runArticleInventoryWorkerV7GroundedOrchestratorStep()'), 'The inventory resume route must never invoke the generic queue drain.');
assert(resumeRoute.includes("process.env.VERCEL_ENV !== 'production'"), 'The inventory resume route must be production-only.');
assert(/export const maxDuration = 300/.test(resumeRoute), 'The exact inventory resume route must keep the verified 300-second duration budget.');

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

assert(sql.includes('enqueue_source_page_inventory_region_ocr_recovery_v2'), 'Database must expose the current-freeze region OCR enqueue v2 RPC.');
assert(sql.includes('no usable fresh OCR anchor blocks'), 'Region OCR enqueue v2 must accept the newer no-usable-anchor review state.');
assert(sql.includes('zero fresh OCR blocks'), 'Region OCR enqueue v2 must preserve compatibility with the original zero-block review state.');
assert(sql.includes("j.inventory_version<>'page_article_inventory_v4_recovered_ocr'"), 'Region OCR enqueue v2 must remain pinned to recovered OCR inventory jobs.');
assert(sql.includes("freeze_gate_v2='passed'"), 'Region OCR enqueue v2 must require the current formal freeze.');
assert(sql.includes('count(distinct pass_kind)'), 'Region OCR enqueue v2 must require independent visual support.');
assert(/revoke all on function public\.enqueue_source_page_inventory_region_ocr_recovery_v2/.test(sql), 'Region OCR enqueue v2 must be hidden from public roles.');
assert(/grant execute on function public\.enqueue_source_page_inventory_region_ocr_recovery_v2/.test(sql), 'Region OCR enqueue v2 must be service-role callable.');

assert(sql.includes("'region_ocr_promotional_false_positive'::text"), 'Visual exclusion constraint must explicitly allow positive region-OCR promotional false positives.');
assert(sql.includes('apply_region_ocr_promotional_false_positive_v1'), 'Database must expose the positive region-OCR promotional exclusion RPC.');
assert(sql.includes("v_region.status<>'completed'"), 'Promotional exclusion must require a completed region OCR receipt.');
assert(sql.includes("v_text !~ '出版'"), 'Promotional exclusion must require publisher evidence.');
assert(sql.includes("v_text !~ '〒' and v_text !~ '東京都'"), 'Promotional exclusion must require address evidence.');
assert(sql.includes('region_ocr_promo_exclusion_adjudicator_supports_region'), 'Promotional exclusion must fail if the independent adjudicator supports the same headline.');
assert(sql.includes("pass_kind='adjudicator' and model='gpt-5.6-sol'"), 'Promotional exclusion must require the GPT-5.6-sol adjudicator receipt.');
assert(sql.includes("set status='queued'"), 'Successful promotional exclusion must resume the existing inventory consensus without clearing its verified pass receipts.');
assert(/revoke all on function public\.apply_region_ocr_promotional_false_positive_v1/.test(sql), 'Promotional exclusion RPC must be hidden from public roles.');

console.log('verify-zero-ocr-region-rescue: ok');
