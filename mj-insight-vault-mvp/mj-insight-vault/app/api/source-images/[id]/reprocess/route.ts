import { POST as handleOcrOnly } from '../ocr-only/route';

// Fail closed while OCR Verification is not authoritative. Reprocess must not bypass
// the OCR rollout gate by segmenting/committing/enriching articles directly from a
// newly OCR'd source image. Keep the endpoint stable, but limit it to explicit OCR-only
// work exactly like /process. Formal downstream work starts only from the gated pipeline.
export const runtime = 'nodejs';
export const maxDuration = 300;
export const POST = handleOcrOnly;
