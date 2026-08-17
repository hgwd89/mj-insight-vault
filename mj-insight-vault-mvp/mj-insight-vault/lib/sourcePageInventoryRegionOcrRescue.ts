import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcrBatch, VisionProviderError } from '@/lib/visionBatch';

type JsonRecord = Record<string, unknown>;
type Region = { x_min: number; y_min: number; x_max: number; y_max: number };
type EvidenceRow = {
  pass_kind: string;
  headline_hint: string;
  regions: unknown;
  model: string;
  provider_response_id: string;
};
type RescueJob = {
  id: string;
  inventory_job_id: string;
  source_image_id: string;
  lease_token: string;
  attempt_count: number;
  crop_json: unknown;
  evidence_json: unknown;
  crop_spec_sha256: string;
  crop_image_sha256: string;
  google_response_sha256: string;
  google_text_sha256: string;
};
type SourceImage = { buffer: Buffer; width: number; height: number };
type SupportedPair = { a: EvidenceRow; b: EvidenceRow; ra: Region; rb: Region; iou: number; hint: number };
type CropVariant = {
  kind: string;
  cropNorm: Region;
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  enhanced: boolean;
  buffer: Buffer;
  cropSpec: JsonRecord;
};

type EvaluatedVariant = CropVariant & {
  fullText: string;
  targetText: string;
  targetBlocks: JsonRecord[];
  hintSimilarity: number;
  responseSha256: string;
  textSha256: string;
  cropImageSha256: string;
  accepted: boolean;
  score: number;
};

class StructuralError extends Error {}

const RESCUE_VERSION = 'inventory_zero_ocr_region_rescue_v2';
const MIN_HINT_SIMILARITY = 0.20;

function text(value: unknown) { return value == null ? '' : String(value).trim(); }
function num(value: unknown, fallback = 0) { const x = Number(value); return Number.isFinite(x) ? x : fallback; }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function normalizeText(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function bigrams(value: string) {
  const normalized = normalizeText(value);
  const out = new Set<string>();
  if (normalized.length === 1) out.add(normalized);
  for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}
function textSimilarity(a: string, b: string) {
  const aa = bigrams(a), bb = bigrams(b);
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const value of aa) if (bb.has(value)) hit += 1;
  return 2 * hit / (aa.size + bb.size);
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : text(error) || 'region OCR rescue failed'; }
function bbox(regions: unknown): Region | null {
  if (!Array.isArray(regions) || !regions.length) return null;
  const values = regions.map((raw) => {
    const r = isRecord(raw) ? raw : {};
    return { x_min: num(r.x_min, NaN), y_min: num(r.y_min, NaN), x_max: num(r.x_max, NaN), y_max: num(r.y_max, NaN) };
  });
  if (values.some((r) => !Object.values(r).every(Number.isFinite))) return null;
  return {
    x_min: Math.min(...values.map((r) => Math.min(r.x_min, r.x_max))),
    y_min: Math.min(...values.map((r) => Math.min(r.y_min, r.y_max))),
    x_max: Math.max(...values.map((r) => Math.max(r.x_min, r.x_max))),
    y_max: Math.max(...values.map((r) => Math.max(r.y_min, r.y_max)))
  };
}
function area(r: Region) { return Math.max(1e-6, (r.x_max - r.x_min) * (r.y_max - r.y_min)); }
function intersection(a: Region, b: Region): Region | null {
  const value = { x_min: Math.max(a.x_min, b.x_min), y_min: Math.max(a.y_min, b.y_min), x_max: Math.min(a.x_max, b.x_max), y_max: Math.min(a.y_max, b.y_max) };
  return value.x_max > value.x_min && value.y_max > value.y_min ? value : null;
}
function union(a: Region, b: Region): Region {
  return { x_min: Math.min(a.x_min, b.x_min), y_min: Math.min(a.y_min, b.y_min), x_max: Math.max(a.x_max, b.x_max), y_max: Math.max(a.y_max, b.y_max) };
}
function iou(a: Region, b: Region) {
  const overlap = intersection(a, b);
  if (!overlap) return 0;
  return area(overlap) / Math.max(1e-6, area(a) + area(b) - area(overlap));
}
function padRegion(region: Region, pad: number): Region {
  return {
    x_min: Math.max(0, region.x_min - pad),
    y_min: Math.max(0, region.y_min - pad),
    x_max: Math.min(1000, region.x_max + pad),
    y_max: Math.min(1000, region.y_max + pad)
  };
}
function detectedBreak(symbol: JsonRecord) {
  const property = isRecord(symbol.property) ? symbol.property : {};
  const detected = isRecord(property.detectedBreak) ? property.detectedBreak : {};
  const kind = text(detected.type);
  if (kind === 'SPACE' || kind === 'SURE_SPACE' || kind === 'EOL_SURE_SPACE') return ' ';
  if (kind === 'LINE_BREAK') return '\n';
  if (kind === 'HYPHEN') return '-';
  return '';
}
function blockText(block: JsonRecord) {
  let out = '';
  for (const paragraphValue of Array.isArray(block.paragraphs) ? block.paragraphs : []) {
    const paragraph = isRecord(paragraphValue) ? paragraphValue : {};
    for (const wordValue of Array.isArray(paragraph.words) ? paragraph.words : []) {
      const word = isRecord(wordValue) ? wordValue : {};
      for (const symbolValue of Array.isArray(word.symbols) ? word.symbols : []) {
        const symbol = isRecord(symbolValue) ? symbolValue : {};
        out += text(symbol.text) + detectedBreak(symbol);
      }
    }
    if (out && !out.endsWith('\n')) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function blockBox(block: JsonRecord) {
  const box = isRecord(block.boundingBox) ? block.boundingBox : {};
  const vertices = Array.isArray(box.vertices) ? box.vertices.filter(isRecord) : [];
  if (!vertices.length) throw new StructuralError('region OCR rescue block has no bounding vertices');
  const xs = vertices.map((v) => num(v.x, 0));
  const ys = vertices.map((v) => num(v.y, 0));
  const xMin = Math.min(...xs), yMin = Math.min(...ys), xMax = Math.max(...xs), yMax = Math.max(...ys);
  if (xMax <= xMin || yMax <= yMin) throw new StructuralError('region OCR rescue block bounds invalid');
  return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax };
}
function parseRecoveredBlocks(raw: JsonRecord, cropLeft: number, cropTop: number, scale: number) {
  const full = isRecord(raw.fullTextAnnotation) ? raw.fullTextAnnotation : {};
  const rows: JsonRecord[] = [];
  for (const pageValue of Array.isArray(full.pages) ? full.pages : []) {
    const page = isRecord(pageValue) ? pageValue : {};
    for (const blockValue of Array.isArray(page.blocks) ? page.blocks : []) {
      const block = isRecord(blockValue) ? blockValue : {};
      const value = blockText(block);
      if (!value) continue;
      const b = blockBox(block);
      const confidence = Number(block.confidence);
      rows.push({
        block_text: value,
        x_min: Math.round(cropLeft + b.x_min / scale),
        y_min: Math.round(cropTop + b.y_min / scale),
        x_max: Math.round(cropLeft + b.x_max / scale),
        y_max: Math.round(cropTop + b.y_max / scale),
        ocr_confidence: Number.isFinite(confidence) ? confidence : null
      });
    }
  }
  return rows;
}
function normalizedToPixels(region: Region, source: SourceImage): Region {
  return {
    x_min: region.x_min / 1000 * source.width,
    y_min: region.y_min / 1000 * source.height,
    x_max: region.x_max / 1000 * source.width,
    y_max: region.y_max / 1000 * source.height
  };
}
function blockCenterInside(block: JsonRecord, region: Region) {
  const cx = (num(block.x_min) + num(block.x_max)) / 2;
  const cy = (num(block.y_min) + num(block.y_max)) / 2;
  return cx >= region.x_min && cx <= region.x_max && cy >= region.y_min && cy <= region.y_max;
}
async function claim(jobId: string) {
  const normal = await supabaseAdmin.rpc('claim_source_page_inventory_region_ocr_recovery_v1', { p_job_id: jobId, p_lease_seconds: 420 });
  if (normal.error) throw normal.error;
  let row = Array.isArray(normal.data) && isRecord(normal.data[0]) ? normal.data[0] : null;
  if (!row) {
    const rescue = await supabaseAdmin.rpc('claim_source_page_inventory_region_ocr_rescue_v2', { p_job_id: jobId, p_lease_seconds: 420 });
    if (rescue.error) throw rescue.error;
    row = Array.isArray(rescue.data) && isRecord(rescue.data[0]) ? rescue.data[0] : null;
  }
  if (!row) return null;
  return {
    id: text(row.id), inventory_job_id: text(row.inventory_job_id), source_image_id: text(row.source_image_id), lease_token: text(row.lease_token),
    attempt_count: num(row.attempt_count), crop_json: row.crop_json, evidence_json: row.evidence_json,
    crop_spec_sha256: text(row.crop_spec_sha256), crop_image_sha256: text(row.crop_image_sha256),
    google_response_sha256: text(row.google_response_sha256), google_text_sha256: text(row.google_text_sha256)
  } as RescueJob;
}
async function loadSource(job: RescueJob): Promise<SourceImage> {
  const loaded = await supabaseAdmin.from('source_images').select('storage_path,width,height,storage_size_bytes').eq('id', job.source_image_id).single();
  if (loaded.error) throw loaded.error;
  const width = num(loaded.data.width), height = num(loaded.data.height), expected = num(loaded.data.storage_size_bytes), storagePath = text(loaded.data.storage_path);
  if (!storagePath || width < 1 || height < 1 || expected < 1) throw new StructuralError('region OCR rescue source metadata incomplete');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (downloaded.error || !downloaded.data) throw downloaded.error || new StructuralError('region OCR rescue source download empty');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (buffer.length !== expected) throw new StructuralError(`region OCR rescue source size drift expected=${expected} actual=${buffer.length}`);
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  if (Number(metadata.width || 0) !== width || Number(metadata.height || 0) !== height) throw new StructuralError('region OCR rescue source dimension drift');
  return { buffer, width, height };
}
async function loadSupportedPair(job: RescueJob): Promise<SupportedPair> {
  const loaded = await supabaseAdmin.from('source_page_inventory_visual_region_evidence_v6')
    .select('pass_kind,headline_hint,regions,model,provider_response_id').eq('job_id', job.inventory_job_id).eq('dropped_from_partition', true);
  if (loaded.error) throw loaded.error;
  const rows = (loaded.data || []) as EvidenceRow[];
  let best: (SupportedPair & { score: number }) | null = null;
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    if (rows[i].pass_kind === rows[j].pass_kind) continue;
    const ra = bbox(rows[i].regions), rb = bbox(rows[j].regions);
    if (!ra || !rb) continue;
    const overlap = iou(ra, rb), hint = textSimilarity(rows[i].headline_hint, rows[j].headline_hint);
    const independentlySupported = (overlap >= 0.25 && hint >= 0.10) || overlap >= 0.50 || hint >= 0.65;
    if (!independentlySupported) continue;
    const score = overlap + hint;
    if (!best || score > best.score) best = { a: rows[i], b: rows[j], ra, rb, iou: overlap, hint, score };
  }
  if (!best) throw new StructuralError('region OCR rescue has no independently supported region pair');
  return best;
}
async function makeVariant(source: SourceImage, cropNorm: Region, kind: string, enhanced: boolean): Promise<CropVariant> {
  const left = Math.max(0, Math.floor(cropNorm.x_min / 1000 * source.width));
  const top = Math.max(0, Math.floor(cropNorm.y_min / 1000 * source.height));
  const right = Math.min(source.width, Math.ceil(cropNorm.x_max / 1000 * source.width));
  const bottom = Math.min(source.height, Math.ceil(cropNorm.y_max / 1000 * source.height));
  const width = right - left, height = bottom - top;
  if (width < 20 || height < 20) throw new StructuralError(`region OCR rescue crop too small: ${kind}`);
  const scale = 3;
  let pipeline = sharp(source.buffer, { failOn: 'error' }).extract({ left, top, width, height }).resize({ width: width * scale, height: height * scale, fit: 'fill', kernel: 'lanczos3' });
  if (enhanced) pipeline = pipeline.grayscale().normalize().sharpen();
  const buffer = await pipeline.png().toBuffer();
  return {
    kind, cropNorm, left, top, width, height, scale, enhanced, buffer,
    cropSpec: { version: RESCUE_VERSION, kind, enhanced, normalized_crop: cropNorm, pixels: { left, top, width, height }, scale }
  };
}
async function fail(job: RescueJob, errorValue: unknown) {
  const retryable = errorValue instanceof VisionProviderError ? errorValue.retryable : errorValue instanceof TypeError;
  const failed = await supabaseAdmin.rpc('fail_source_page_inventory_region_ocr_recovery_v1', { p_job_id: job.id, p_lease_token: job.lease_token, p_error: errorMessage(errorValue), p_retryable: retryable });
  if (failed.error) throw failed.error;
  return failed.data;
}

export async function runSourcePageInventoryRegionOcrRescueStep(jobId: string) {
  const job = await claim(jobId);
  if (!job) return { claimed: 0, stage: 'idle', external_calls: 0 };
  try {
    const [source, pair] = await Promise.all([loadSource(job), loadSupportedPair(job)]);
    const core = intersection(pair.ra, pair.rb) || union(pair.ra, pair.rb);
    const supportedUnion = union(pair.ra, pair.rb);
    const unionWide = padRegion(supportedUnion, 45);
    const bottomBand: Region = { x_min: 0, y_min: Math.max(0, Math.min(supportedUnion.y_min, core.y_min) - 90), x_max: 1000, y_max: 1000 };
    const variants = await Promise.all([
      makeVariant(source, unionWide, 'supported_union_color', false),
      makeVariant(source, unionWide, 'supported_union_enhanced', true),
      makeVariant(source, bottomBand, 'bottom_band_color', false),
      makeVariant(source, bottomBand, 'bottom_band_enhanced', true)
    ]);
    const fresh = await runDocumentOcrBatch(variants.map((variant) => variant.buffer));
    const targetPixels = normalizedToPixels(supportedUnion, source);
    const evaluated: EvaluatedVariant[] = fresh.map((result, index) => {
      const variant = variants[index];
      const raw = result.raw as JsonRecord;
      const allBlocks = parseRecoveredBlocks(raw, variant.left, variant.top, variant.scale);
      const targetBlocks = allBlocks.filter((block) => blockCenterInside(block, targetPixels));
      const targetText = targetBlocks.map((block) => text(block.block_text)).filter(Boolean).join('\n').trim();
      const hintSimilarity = Math.max(textSimilarity(targetText, pair.a.headline_hint), textSimilarity(targetText, pair.b.headline_hint));
      const accepted = targetBlocks.length > 0 && targetText.length >= 8 && hintSimilarity >= MIN_HINT_SIMILARITY;
      return {
        ...variant, fullText: result.text, targetText, targetBlocks, hintSimilarity,
        responseSha256: sha256(JSON.stringify(raw)), textSha256: sha256(result.text), cropImageSha256: sha256(variant.buffer), accepted,
        score: hintSimilarity * 10000 + Math.min(targetText.length, 2000) + targetBlocks.length * 10
      };
    });
    evaluated.sort((a, b) => b.score - a.score);
    const selected = evaluated[0];
    if (!selected) throw new StructuralError('region OCR rescue produced no evaluated variants');
    const accepted = Boolean(selected.accepted);
    const recoveredText = accepted ? selected.targetText : '';
    const recoveredBlocks = accepted ? selected.targetBlocks : [];
    const evidence = {
      pass_a: { pass_kind: pair.a.pass_kind, headline_hint: pair.a.headline_hint, model: pair.a.model, provider_response_id: pair.a.provider_response_id, bbox: pair.ra },
      pass_b: { pass_kind: pair.b.pass_kind, headline_hint: pair.b.headline_hint, model: pair.b.model, provider_response_id: pair.b.provider_response_id, bbox: pair.rb },
      iou: pair.iou,
      hint_similarity: pair.hint,
      rescue: {
        version: RESCUE_VERSION,
        acceptance_min_hint_similarity: MIN_HINT_SIMILARITY,
        accepted,
        selected_variant: selected.kind,
        selected_hint_similarity: selected.hintSimilarity,
        prior_attempt: {
          attempt_count: Math.max(0, job.attempt_count - 1),
          crop_json: job.crop_json,
          evidence_json: job.evidence_json,
          crop_spec_sha256: job.crop_spec_sha256,
          crop_image_sha256: job.crop_image_sha256,
          google_response_sha256: job.google_response_sha256,
          google_text_sha256: job.google_text_sha256
        },
        variants: evaluated.map((variant) => ({
          kind: variant.kind,
          crop_spec: variant.cropSpec,
          crop_image_sha256: variant.cropImageSha256,
          google_response_sha256: variant.responseSha256,
          google_text_sha256: variant.textSha256,
          full_text_length: variant.fullText.length,
          target_text_length: variant.targetText.length,
          target_block_count: variant.targetBlocks.length,
          hint_similarity: variant.hintSimilarity,
          accepted: variant.accepted
        }))
      }
    };
    const completed = await supabaseAdmin.rpc('complete_source_page_inventory_region_ocr_recovery_v1', {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_source_binary_sha256: sha256(source.buffer),
      p_crop_spec_sha256: sha256(JSON.stringify(selected.cropSpec)),
      p_crop_image_sha256: selected.cropImageSha256,
      p_google_response_sha256: selected.responseSha256,
      p_google_text_sha256: selected.textSha256,
      p_recovered_text: recoveredText,
      p_recovered_blocks: recoveredBlocks,
      p_crop_json: selected.cropSpec,
      p_evidence_json: evidence
    });
    if (completed.error) throw completed.error;
    return {
      claimed: 1,
      job_id: job.id,
      inventory_job_id: job.inventory_job_id,
      stage: accepted ? 'completed' : 'needs_review',
      accepted,
      selected_variant: selected.kind,
      selected_hint_similarity: selected.hintSimilarity,
      recovered_blocks: recoveredBlocks.length,
      recovered_text_length: recoveredText.length,
      completed: completed.data,
      external_calls: 1
    };
  } catch (error) {
    return { claimed: 1, job_id: job.id, inventory_job_id: job.inventory_job_id, stage: 'failed', error: errorMessage(error), result: await fail(job, error), external_calls: 1 };
  }
}
