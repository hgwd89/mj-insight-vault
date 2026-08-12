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
type ClaimedJob = {
  id: string;
  inventory_job_id: string;
  source_image_id: string;
  lease_token: string;
};

class StructuralError extends Error {}

function text(value: unknown) { return value == null ? '' : String(value).trim(); }
function num(value: unknown, fallback = 0) { const x = Number(value); return Number.isFinite(x) ? x : fallback; }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function normalizeText(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function bigrams(value: string) {
  const n = normalizeText(value); const out = new Set<string>();
  if (n.length === 1) out.add(n);
  for (let i = 0; i < n.length - 1; i += 1) out.add(n.slice(i, i + 2));
  return out;
}
function textSimilarity(a: string, b: string) {
  const aa = bigrams(a), bb = bigrams(b); if (!aa.size || !bb.size) return 0;
  let hit = 0; for (const x of aa) if (bb.has(x)) hit += 1;
  return 2 * hit / (aa.size + bb.size);
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : text(error) || 'region OCR recovery failed'; }
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
  const r = { x_min: Math.max(a.x_min, b.x_min), y_min: Math.max(a.y_min, b.y_min), x_max: Math.min(a.x_max, b.x_max), y_max: Math.min(a.y_max, b.y_max) };
  return r.x_max > r.x_min && r.y_max > r.y_min ? r : null;
}
function union(a: Region, b: Region): Region {
  return { x_min: Math.min(a.x_min, b.x_min), y_min: Math.min(a.y_min, b.y_min), x_max: Math.max(a.x_max, b.x_max), y_max: Math.max(a.y_max, b.y_max) };
}
function iou(a: Region, b: Region) {
  const inter = intersection(a, b); if (!inter) return 0;
  return area(inter) / Math.max(1e-6, area(a) + area(b) - area(inter));
}
function detectedBreak(symbol: JsonRecord) {
  const property = isRecord(symbol.property) ? symbol.property : {};
  const br = isRecord(property.detectedBreak) ? property.detectedBreak : {};
  const type = text(br.type);
  if (type === 'SPACE' || type === 'SURE_SPACE' || type === 'EOL_SURE_SPACE') return ' ';
  if (type === 'LINE_BREAK') return '\n';
  if (type === 'HYPHEN') return '-';
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
  if (!vertices.length) throw new StructuralError('region OCR block has no bounding vertices');
  const xs = vertices.map((v) => num(v.x, 0)), ys = vertices.map((v) => num(v.y, 0));
  const xMin = Math.min(...xs), yMin = Math.min(...ys), xMax = Math.max(...xs), yMax = Math.max(...ys);
  if (xMax <= xMin || yMax <= yMin) throw new StructuralError('region OCR block bounds invalid');
  return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax };
}
function parseRecoveredBlocks(raw: JsonRecord, cropLeft: number, cropTop: number, scale: number) {
  const full = isRecord(raw.fullTextAnnotation) ? raw.fullTextAnnotation : {};
  const rows: JsonRecord[] = [];
  for (const pageValue of Array.isArray(full.pages) ? full.pages : []) {
    const page = isRecord(pageValue) ? pageValue : {};
    for (const blockValue of Array.isArray(page.blocks) ? page.blocks : []) {
      const block = isRecord(blockValue) ? blockValue : {};
      const value = blockText(block); if (!value) continue;
      const b = blockBox(block); const confidence = Number(block.confidence);
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
async function claim(jobId?: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_inventory_region_ocr_recovery_v1', { p_job_id: jobId || null, p_lease_seconds: 420 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  return { id: text(row.id), inventory_job_id: text(row.inventory_job_id), source_image_id: text(row.source_image_id), lease_token: text(row.lease_token) } as ClaimedJob;
}
async function loadSource(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.from('source_images').select('storage_path,mime_type,width,height,storage_size_bytes').eq('id', job.source_image_id).single();
  if (error) throw error;
  const width = num(data.width), height = num(data.height), expected = num(data.storage_size_bytes); const path = text(data.storage_path);
  if (!path || width < 1 || height < 1 || expected < 1) throw new StructuralError('region OCR source metadata incomplete');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(path);
  if (downloaded.error || !downloaded.data) throw downloaded.error || new StructuralError('region OCR source download empty');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (buffer.length !== expected) throw new StructuralError(`region OCR source size drift expected=${expected} actual=${buffer.length}`);
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  if (Number(metadata.width || 0) !== width || Number(metadata.height || 0) !== height) throw new StructuralError('region OCR source dimension drift');
  return { buffer, width, height, mimeType: text(data.mime_type) || downloaded.data.type || 'image/jpeg' };
}
async function loadSupportedPair(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.from('source_page_inventory_visual_region_evidence_v6')
    .select('pass_kind,headline_hint,regions,model,provider_response_id').eq('job_id', job.inventory_job_id).eq('dropped_from_partition', true);
  if (error) throw error;
  const rows = (data || []) as EvidenceRow[]; let best: { a: EvidenceRow; b: EvidenceRow; ra: Region; rb: Region; iou: number; hint: number; score: number } | null = null;
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    if (rows[i].pass_kind === rows[j].pass_kind) continue;
    const ra = bbox(rows[i].regions), rb = bbox(rows[j].regions); if (!ra || !rb) continue;
    const overlap = iou(ra, rb), hint = textSimilarity(rows[i].headline_hint, rows[j].headline_hint);
    const supported = (overlap >= 0.25 && hint >= 0.10) || overlap >= 0.50 || hint >= 0.65;
    if (!supported) continue;
    const score = overlap + hint;
    if (!best || score > best.score) best = { a: rows[i], b: rows[j], ra, rb, iou: overlap, hint, score };
  }
  if (!best) throw new StructuralError('region OCR recovery has no independently supported zero-block region pair');
  return best;
}
async function fail(job: ClaimedJob, errorValue: unknown) {
  const retryable = errorValue instanceof VisionProviderError ? errorValue.retryable : errorValue instanceof TypeError;
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_inventory_region_ocr_recovery_v1', { p_job_id: job.id, p_lease_token: job.lease_token, p_error: errorMessage(errorValue), p_retryable: retryable });
  if (error) throw error; return data;
}
export async function getSourcePageInventoryRegionOcrRecoveryStatus() {
  const { data, error } = await supabaseAdmin.from('source_page_inventory_region_ocr_recovery_v1').select('status');
  if (error) throw error;
  const counts: Record<string, number> = {}; for (const row of data || []) counts[text(row.status)] = (counts[text(row.status)] || 0) + 1;
  return { counts };
}
export async function runSourcePageInventoryRegionOcrRecoveryWorkerStep(jobId?: string) {
  const job = await claim(jobId); if (!job) return { claimed: 0, stage: 'idle', external_calls: 0 };
  try {
    const [source, pair] = await Promise.all([loadSource(job), loadSupportedPair(job)]);
    const core = intersection(pair.ra, pair.rb) || union(pair.ra, pair.rb); const all = union(pair.ra, pair.rb); const pad = 30;
    const cropNorm: Region = { x_min: Math.max(0, core.x_min - pad), y_min: Math.max(0, core.y_min - pad), x_max: Math.min(1000, core.x_max + pad), y_max: Math.min(1000, core.y_max + pad) };
    const left = Math.max(0, Math.floor(cropNorm.x_min / 1000 * source.width)); const top = Math.max(0, Math.floor(cropNorm.y_min / 1000 * source.height));
    const right = Math.min(source.width, Math.ceil(cropNorm.x_max / 1000 * source.width)); const bottom = Math.min(source.height, Math.ceil(cropNorm.y_max / 1000 * source.height));
    const width = right - left, height = bottom - top; if (width < 20 || height < 20) throw new StructuralError('region OCR crop too small');
    const scale = Math.max(2, Math.min(3, Math.ceil(Math.max(900 / height, 1200 / width, 2))));
    const cropBuffer = await sharp(source.buffer, { failOn: 'error' }).extract({ left, top, width, height }).resize({ width: width * scale, height: height * scale, fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    const sourceBinarySha256 = sha256(source.buffer); const cropImageSha256 = sha256(cropBuffer);
    const cropSpec = { version: 'inventory_zero_ocr_region_crop_v1', normalized_core: core, normalized_union: all, normalized_crop: cropNorm, pixels: { left, top, width, height }, scale };
    const cropSpecSha256 = sha256(JSON.stringify(cropSpec));
    const [fresh] = await runDocumentOcrBatch([cropBuffer]);
    const raw = fresh.raw as JsonRecord; const recoveredBlocks = parseRecoveredBlocks(raw, left, top, scale);
    const googleResponseSha256 = sha256(JSON.stringify(raw)); const googleTextSha256 = sha256(fresh.text);
    const evidence = {
      pass_a: { pass_kind: pair.a.pass_kind, headline_hint: pair.a.headline_hint, model: pair.a.model, provider_response_id: pair.a.provider_response_id, bbox: pair.ra },
      pass_b: { pass_kind: pair.b.pass_kind, headline_hint: pair.b.headline_hint, model: pair.b.model, provider_response_id: pair.b.provider_response_id, bbox: pair.rb },
      iou: pair.iou, hint_similarity: pair.hint
    };
    const { data: completed, error } = await supabaseAdmin.rpc('complete_source_page_inventory_region_ocr_recovery_v1', {
      p_job_id: job.id, p_lease_token: job.lease_token, p_source_binary_sha256: sourceBinarySha256, p_crop_spec_sha256: cropSpecSha256, p_crop_image_sha256: cropImageSha256,
      p_google_response_sha256: googleResponseSha256, p_google_text_sha256: googleTextSha256, p_recovered_text: fresh.text, p_recovered_blocks: recoveredBlocks, p_crop_json: cropSpec, p_evidence_json: evidence
    });
    if (error) throw error;
    return { claimed: 1, job_id: job.id, inventory_job_id: job.inventory_job_id, stage: 'completed', recovered_blocks: recoveredBlocks.length, recovered_text_length: fresh.text.length, crop: cropSpec, completed, external_calls: 1 };
  } catch (error) {
    return { claimed: 1, job_id: job.id, inventory_job_id: job.inventory_job_id, stage: 'failed', error: errorMessage(error), result: await fail(job, error), external_calls: 1 };
  }
}
