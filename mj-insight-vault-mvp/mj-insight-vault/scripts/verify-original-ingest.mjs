import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (ok, message) => { if (!ok) throw new Error(message); };

const form = read('components/UploadFormStable.tsx');
const client = read('lib/originalUploadClient.ts');
const signRoute = read('app/api/upload/original-sign/route.ts');
const imageRoute = read('app/api/upload/image/route.ts');
const provenance = read('supabase/migrations/20260808012915_strengthen_original_image_provenance_v3.sql');
const provenanceRpc = read('supabase/migrations/20260808013142_add_verified_original_ingest_rpc_v3.sql');
const idempotency = read('supabase/migrations/20260808024754_make_source_image_ingest_idempotent_v4.sql');

assert(form.includes('uploadOriginalImageDirect'), 'Upload UI must preserve the original before OCR derivative generation.');
assert(form.includes('原画像保存中') && form.includes('原画像保存済み'), 'Original-preservation stage must be visible.');
assert(client.includes("crypto.subtle.digest('SHA-256'"), 'Browser must fingerprint original bytes with SHA-256.');
assert(client.includes("method: 'PUT'") && client.includes('cacheControl') && client.includes('x-upsert'), 'Signed upload must match Supabase uploadToSignedUrl semantics.');
assert(signRoute.includes('original_sha256') && signRoute.includes('createSignedUploadUrl(path, { upsert: true })'), 'Signed original path must be SHA-bound and retry-safe.');
assert(signRoute.includes('/original/') && signRoute.includes('originalSha256'), 'Original path must be content-addressed.');
assert(imageRoute.includes('download(originalStoragePath)') && imageRoute.includes('Original image SHA-256 verification failed'), 'Server must re-read and verify original bytes.');
assert(imageRoute.includes('OCR_DERIVATIVE_VERSION') && imageRoute.includes('/ocr/'), 'OCR derivative must have a separate versioned identity.');
assert(imageRoute.includes('record_source_image_ingest_provenance_v3'), 'Verified provenance RPC is required.');
assert(imageRoute.includes('ingest_slot') && imageRoute.includes('source_image_ingest_slot_status_v4'), 'Upload must be idempotent by batch + ingest slot.');
assert(provenance.includes('original_size_bytes') && provenance.includes('original_verified_at'), 'Strict provenance must store verified original byte metadata.');
assert(provenanceRpc.includes('record_source_image_ingest_provenance_v3'), 'Strict ingest provenance RPC migration is missing.');
assert(idempotency.includes('source_images_batch_ingest_slot_unique_v4'), 'Database must enforce one source image per batch ingest slot.');
assert(idempotency.includes('source_image_ingest_slot_status_v4'), 'Idempotent replay lookup RPC is missing.');

console.log('verify-original-ingest: ok');
