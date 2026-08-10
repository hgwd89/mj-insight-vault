import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcrBatch, VisionProviderError } from '@/lib/visionBatch';

type JsonRecord = Record<string, unknown>;
type Rect = { block_index: number; block_text: string; x_min: number; y_min: number; x_max: number; y_max: number; ocr_confidence: number | null };
type ClaimedJob = { id: string; page_identity_source_image_id: string; source_image_id: string; source_ocr_json_sha256: string; old_block_count: number; lease_token: string };

class StructuralError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}
function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
function num(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : text(error) || 'page OCR recovery failed';
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
  const paragraphs = Array.isArray(block.paragraphs) ? block.paragraphs : [];
  for (const paragraphValue of paragraphs) {
    const paragraph = isRecord(paragraphValue) ? paragraphValue : {};
    const words = Array.isArray(paragraph.words) ? paragraph.words : [];
    for (const wordValue of words) {
      const word = isRecord(wordValue) ? wordValue : {};
      const symbols = Array.isArray(word.symbols) ? word.symbols : [];
      for (const symbolValue of symbols) {
        const symbol = isRecord(symbolValue) ? symbolValue : {};
        out += text(symbol.text);
        out += detectedBreak(symbol);
      }
    }
    if (out && !out.endsWith('\n')) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function blockBox(block: JsonRecord) {
  const box = isRecord(block.boundingBox) ? block.boundingBox : {};
  const vertices = Array.isArray(box.vertices) ? box.vertices.filter(isRecord) : [];
  if (!vertices.length) throw new StructuralError('fresh Google OCR block has no bounding vertices');
  const xs = vertices.map((v) => num(v.x, 0));
  const ys = vertices.map((v) => num(v.y, 0));
  const xMin = Math.round(Math.min(...xs));
  const yMin = Math.round(Math.min(...ys));
  const xMax = Math.round(Math.max(...xs));
  const yMax = Math.round(Math.max(...ys));
  if (xMax <= xMin || yMax <= yMin) throw new StructuralError('fresh Google OCR block has invalid bounds');
  return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax };
}

function parseFreshBlocks(raw: JsonRecord) {
  const full = isRecord(raw.fullTextAnnotation) ? raw.fullTextAnnotation : {};
  const pages = Array.isArray(full.pages) ? full.pages : [];
  const result: Rect[] = [];
  let blockIndex = 0;
  for (const pageValue of pages) {
    const page = isRecord(pageValue) ? pageValue : {};
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    for (const blockValue of blocks) {
      const block = isRecord(blockValue) ? blockValue : {};
      const value = blockText(block);
      if (!value) continue;
      const box = blockBox(block);
      const confidence = Number(block.confidence);
      result.push({
        block_index: blockIndex++,
        block_text: value,
        ...box,
        ocr_confidence: Number.isFinite(confidence) ? confidence : null
      });
    }
  }
  if (!result.length) throw new StructuralError('fresh Google OCR returned no text blocks');
  return result;
}

function iou(a: Rect, b: Rect) {
  const left = Math.max(a.x_min, b.x_min);
  const top = Math.max(a.y_min, b.y_min);
  const right = Math.min(a.x_max, b.x_max);
  const bottom = Math.min(a.y_max, b.y_max);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (!intersection) return 0;
  const areaA = (a.x_max - a.x_min) * (a.y_max - a.y_min);
  const areaB = (b.x_max - b.x_min) * (b.y_max - b.y_min);
  return intersection / Math.max(1, areaA + areaB - intersection);
}

async function ensureJobs() {
  const { data, error } = await supabaseAdmin.rpc('enqueue_source_page_ocr_recovery_jobs_v1');
  if (error) throw error;
  return Number(data || 0);
}

async function claimJob() {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_ocr_recovery_job_v1', { p_lease_seconds: 300 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job: ClaimedJob = {
    id: text(row.id),
    page_identity_source_image_id: text(row.page_identity_source_image_id),
    source_image_id: text(row.source_image_id),
    source_ocr_json_sha256: text(row.source_ocr_json_sha256),
    old_block_count: num(row.old_block_count),
    lease_token: text(row.lease_token)
  };
  if (!job.id || !job.source_image_id || !job.source_ocr_json_sha256 || !job.lease_token || job.old_block_count < 1) {
    throw new StructuralError('claimed page OCR recovery job is incomplete');
  }
  return job;
}

async function loadSource(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin
    .from('source_images')
    .select('id,storage_path,mime_type,width,height,storage_etag,storage_size_bytes')
    .eq('id', job.source_image_id)
    .single();
  if (error) throw error;
  const path = text(data.storage_path);
  const width = num(data.width);
  const height = num(data.height);
  const expectedSize = num(data.storage_size_bytes);
  if (!path || width < 1 || height < 1 || expectedSize < 1) throw new StructuralError('source image metadata is incomplete');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(path);
  if (downloaded.error) throw downloaded.error;
  if (!downloaded.data) throw new StructuralError('source image download returned no data');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (buffer.length !== expectedSize) throw new StructuralError(`source binary size mismatch expected=${expectedSize} actual=${buffer.length}`);
  return { buffer, width, height, mimeType: text(data.mime_type) || downloaded.data.type || 'image/jpeg' };
}

async function loadOldBlocks(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin
    .from('source_ocr_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence')
    .eq('source_image_id', job.source_image_id)
    .eq('page_index', 0)
    .eq('source_ocr_json_sha256', job.source_ocr_json_sha256)
    .order('block_index', { ascending: true });
  if (error) throw error;
  const blocks = (data || []).map((row) => ({
    block_index: num(row.block_index),
    block_text: text(row.block_text),
    x_min: num(row.x_min), y_min: num(row.y_min), x_max: num(row.x_max), y_max: num(row.y_max),
    ocr_confidence: row.ocr_confidence === null ? null : num(row.ocr_confidence)
  })) as Rect[];
  if (blocks.length !== job.old_block_count) throw new StructuralError(`old OCR block count drift ${blocks.length} != ${job.old_block_count}`);
  return blocks;
}

function annotateMatches(fresh: Rect[], old: Rect[]) {
  return fresh.map((block) => {
    let best: Rect | null = null;
    let bestIou = 0;
    for (const candidate of old) {
      const score = iou(block, candidate);
      if (score > bestIou) { bestIou = score; best = candidate; }
    }
    return {
      ...block,
      best_old_block_index: best ? best.block_index : null,
      best_iou: bestIou,
      candidate_kind: bestIou >= 0.05 ? 'matched' : 'missing_candidate'
    };
  });
}

async function persistFailure(job: ClaimedJob, errorValue: unknown) {
  const retryable = errorValue instanceof VisionProviderError ? errorValue.retryable : errorValue instanceof TypeError;
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_ocr_recovery_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error: errorMessage(errorValue),
    p_retryable: retryable
  });
  if (error) throw error;
  return data;
}

export async function getSourcePageOcrRecoveryStatus() {
  const [{ data: gate, error: gateError }, { data: rows, error: jobsError }] = await Promise.all([
    supabaseAdmin.from('source_page_ocr_recovery_gate_v1').select('*').maybeSingle(),
    supabaseAdmin.from('source_page_ocr_recovery_jobs_v1').select('status,stage')
  ]);
  if (gateError) throw gateError;
  if (jobsError) throw jobsError;
  const counts: Record<string, number> = {};
  for (const row of rows || []) counts[text(row.status)] = (counts[text(row.status)] || 0) + 1;
  return { gate, counts };
}

export async function runSourcePageOcrRecoveryWorkerStep() {
  const enqueued = await ensureJobs();
  const job = await claimJob();
  if (!job) return { claimed: 0, stage: 'idle', enqueued, external_calls: 0 };
  try {
    const [source, oldBlocks] = await Promise.all([loadSource(job), loadOldBlocks(job)]);
    const binarySha256 = sha256(source.buffer);
    const [freshResult] = await runDocumentOcrBatch([source.buffer]);
    const freshBlocks = parseFreshBlocks(freshResult.raw as JsonRecord);
    const annotated = annotateMatches(freshBlocks, oldBlocks);
    const googleResponseSha256 = sha256(JSON.stringify(freshResult.raw));
    const googleTextSha256 = sha256(freshResult.text);
    const { data: stored, error: storeError } = await supabaseAdmin.rpc('record_source_page_ocr_recovery_fresh_v1', {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_source_binary_sha256: binarySha256,
      p_fresh_google_response_sha256: googleResponseSha256,
      p_fresh_google_text_sha256: googleTextSha256,
      p_blocks: annotated
    });
    if (storeError) throw storeError;
    const { data: finalized, error: finalizeError } = await supabaseAdmin.rpc('finalize_source_page_ocr_recovery_job_v1', {
      p_job_id: job.id,
      p_lease_token: job.lease_token
    });
    if (finalizeError) throw finalizeError;
    return {
      claimed: 1,
      job_id: job.id,
      stage: 'completed',
      source_binary_sha256: binarySha256,
      fresh_blocks: freshBlocks.length,
      missing_candidates: annotated.filter((row) => row.candidate_kind === 'missing_candidate').length,
      stored,
      finalized,
      external_calls: 1
    };
  } catch (error) {
    return { claimed: 1, job_id: job.id, stage: 'failed', error: errorMessage(error), result: await persistFailure(job, error), external_calls: 1 };
  }
}
