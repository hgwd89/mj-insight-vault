import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { backupImageToGoogleDrive } from '@/lib/googleDriveBackup';

export const runtime = 'nodejs';
export const maxDuration = 90;

const MAX_DERIVATIVE_BYTES = 3.5 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
const OCR_DERIVATIVE_VERSION = 'ocr-jpeg-v1';

function getMimeType(file: File) {
  const lowerName = (file.name || '').toLowerCase();
  if (file.type) return file.type.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function shaFromOriginalPath(path: string) {
  return path.match(/_([0-9a-f]{64})\.[^/]+$/i)?.[1]?.toLowerCase() || '';
}

async function updateBatchStatus(batchId: string, status: string) {
  const first = await supabaseAdmin
    .from('upload_batches')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', batchId);
  if (!first.error) return;
  const fallback = await supabaseAdmin.from('upload_batches').update({ status }).eq('id', batchId);
  if (fallback.error) throw fallback.error;
}

function appendBackupMessage(base: string, backup: { ok: boolean; skipped?: boolean; file_id?: string; error?: string }) {
  if (backup.skipped) return base;
  if (backup.ok) return `${base}; drive_file_id=${backup.file_id || ''}`;
  return `${base}; drive_backup_error=${backup.error || 'unknown'}`;
}

async function readSlot(batchId: string, ingestSlot: number) {
  const { data, error } = await supabaseAdmin.rpc('source_image_ingest_slot_status_v4', {
    p_batch_id: batchId,
    p_ingest_slot: ingestSlot
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : null;
}

async function readSourceImage(sourceImageId: string) {
  const { data, error } = await supabaseAdmin.from('source_images').select('*').eq('id', sourceImageId).single();
  if (error) throw error;
  return data;
}

async function readProvenance(sourceImageId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_image_ingest_provenance_v2')
    .select('original_storage_path,original_sha256,original_size_bytes,original_mime_type,ocr_derivative_storage_path,ocr_derivative_sha256,ocr_derivative_size_bytes,ocr_derivative_mime_type,quality_status,ingest_mode')
    .eq('source_image_id', sourceImageId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const form = await req.formData();
    const batchId = String(form.get('batch_id') || '').trim();
    const rawIndex = Number(form.get('index') || 0);
    const safeIndex = Number.isFinite(rawIndex) && rawIndex > 0 ? Math.floor(rawIndex) : 1;
    const fallbackArticleDate = String(form.get('article_date') || '').trim();
    const derivativeFile = form.get('file');
    const originalStoragePath = String(form.get('original_storage_path') || '').trim();
    const originalFileName = String(form.get('original_file_name') || '').trim();
    const declaredOriginalMime = String(form.get('original_mime_type') || '').trim().toLowerCase();
    const declaredOriginalSize = Number(form.get('original_size_bytes') || 0);
    const formSha = String(form.get('original_sha256') || '').trim().toLowerCase();
    const declaredOriginalSha256 = formSha || shaFromOriginalPath(originalStoragePath);

    if (!batchId) return Response.json({ error: 'batch_id is required' }, { status: 400 });
    if (!(derivativeFile instanceof File)) return Response.json({ error: 'OCR derivative file is required' }, { status: 400 });
    if (!originalStoragePath.startsWith(`${batchId}/original/${String(safeIndex).padStart(2, '0')}_`)) {
      return Response.json({ error: 'verified original_storage_path is required' }, { status: 400 });
    }
    if (!originalFileName) return Response.json({ error: 'original_file_name is required' }, { status: 400 });
    if (!/^[0-9a-f]{64}$/.test(declaredOriginalSha256) || shaFromOriginalPath(originalStoragePath) !== declaredOriginalSha256) {
      return Response.json({ error: 'original SHA-256 does not match the signed original path' }, { status: 400 });
    }
    if (!Number.isFinite(declaredOriginalSize) || declaredOriginalSize <= 0 || declaredOriginalSize > MAX_ORIGINAL_BYTES) {
      return Response.json({ error: 'original_size_bytes is invalid' }, { status: 400 });
    }
    if (derivativeFile.size <= 0 || derivativeFile.size > MAX_DERIVATIVE_BYTES) {
      return Response.json({ error: `OCR derivative exceeds ${MAX_DERIVATIVE_BYTES} bytes.` }, { status: 400 });
    }

    const { data: batch, error: batchError } = await supabaseAdmin
      .from('upload_batches')
      .select('id')
      .eq('id', batchId)
      .single();
    if (batchError) throw batchError;
    if (!batch) return Response.json({ error: 'batch not found' }, { status: 404 });

    const originalDownload = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(originalStoragePath);
    if (originalDownload.error) throw originalDownload.error;
    if (!originalDownload.data) throw new Error('Uploaded original image could not be read back from storage.');
    const originalBuffer = Buffer.from(await originalDownload.data.arrayBuffer());
    if (originalBuffer.byteLength !== declaredOriginalSize) {
      throw new Error(`Original image size mismatch: declared=${declaredOriginalSize} actual=${originalBuffer.byteLength}`);
    }
    const originalSha256 = sha256(originalBuffer);
    if (originalSha256 !== declaredOriginalSha256) throw new Error('Original image SHA-256 verification failed.');
    const originalMimeType = (originalDownload.data.type || declaredOriginalMime || 'application/octet-stream').toLowerCase();
    if (declaredOriginalMime && originalMimeType !== 'application/octet-stream' && originalMimeType !== declaredOriginalMime) {
      throw new Error(`Original image MIME mismatch: declared=${declaredOriginalMime} actual=${originalMimeType}`);
    }

    const existing = await readSlot(batchId, safeIndex);
    if (existing?.source_image_id) {
      const sourceImageId = String(existing.source_image_id);
      const provenance = await readProvenance(sourceImageId);
      if (provenance?.quality_status === 'passed' && provenance.ingest_mode === 'original_and_ocr_derivative') {
        if (String(existing.file_name) !== originalFileName || provenance.original_sha256 !== originalSha256 || provenance.original_storage_path !== originalStoragePath) {
          return Response.json({ error: 'This batch slot is already registered to a different original image.' }, { status: 409 });
        }
        await updateBatchStatus(batchId, 'queued');
        return Response.json({ image: await readSourceImage(sourceImageId), provenance, idempotent_replay: true });
      }
      if (String(existing.file_name) !== originalFileName) {
        return Response.json({ error: 'This batch slot contains an incomplete ingest for a different file.' }, { status: 409 });
      }
    }

    const derivativeBuffer = Buffer.from(await derivativeFile.arrayBuffer());
    const derivativeMimeType = getMimeType(derivativeFile);
    if (derivativeMimeType !== 'image/jpeg') throw new Error(`OCR derivative must be JPEG, got ${derivativeMimeType}`);
    const derivativeSha256 = sha256(derivativeBuffer);
    const derivativePath = `${batchId}/ocr/${String(safeIndex).padStart(2, '0')}_${originalSha256}_${OCR_DERIVATIVE_VERSION}.jpg`;

    const upload = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(derivativePath, derivativeBuffer, {
      contentType: derivativeMimeType,
      upsert: true
    });
    if (upload.error) throw upload.error;

    let sourceImageId = existing?.source_image_id ? String(existing.source_image_id) : '';
    if (!sourceImageId) {
      const inserted = await supabaseAdmin
        .from('source_images')
        .insert({
          batch_id: batchId,
          ingest_slot: safeIndex,
          file_name: originalFileName,
          storage_path: derivativePath,
          mime_type: derivativeMimeType,
          file_sha256: derivativeSha256,
          ocr_status: 'queued',
          error_message: fallbackArticleDate ? `queued; article_date=${fallbackArticleDate}` : 'queued'
        })
        .select('id')
        .single();
      if (inserted.error) {
        const raced = await readSlot(batchId, safeIndex);
        if (!raced?.source_image_id) throw inserted.error;
        sourceImageId = String(raced.source_image_id);
      } else {
        sourceImageId = String(inserted.data.id);
      }
    }

    const sourceImage = await readSourceImage(sourceImageId);
    if (String(sourceImage.storage_path || '') !== derivativePath) throw new Error('Existing ingest slot points to a different OCR derivative.');
    if (String(sourceImage.file_name || '') !== originalFileName) throw new Error('Existing ingest slot points to a different original filename.');

    const transformJson = {
      original_preserved: true,
      derivative_role: 'google_vision_ocr_input',
      derivative_version: OCR_DERIVATIVE_VERSION,
      derivative_format: 'image/jpeg',
      max_side: 4200,
      jpeg_quality: 0.95,
      source_original_file_name: originalFileName
    };
    const { data: provenance, error: provenanceError } = await supabaseAdmin.rpc('record_source_image_ingest_provenance_v3', {
      p_source_image_id: sourceImageId,
      p_original_storage_path: originalStoragePath,
      p_original_sha256: originalSha256,
      p_original_size_bytes: originalBuffer.byteLength,
      p_original_mime_type: originalMimeType,
      p_derivative_sha256: derivativeSha256,
      p_derivative_size_bytes: derivativeBuffer.byteLength,
      p_derivative_mime_type: derivativeMimeType,
      p_transform_json: transformJson
    });
    if (provenanceError) throw provenanceError;

    const driveBackup = await backupImageToGoogleDrive({
      buffer: originalBuffer,
      fileName: originalFileName,
      mimeType: originalMimeType,
      batchId,
      index: safeIndex
    });
    const baseMessage = fallbackArticleDate ? `queued; article_date=${fallbackArticleDate}` : 'queued';
    const { error: messageError } = await supabaseAdmin
      .from('source_images')
      .update({ error_message: appendBackupMessage(baseMessage, driveBackup) })
      .eq('id', sourceImageId);
    if (messageError) throw messageError;

    await updateBatchStatus(batchId, 'queued');
    return Response.json({
      image: await readSourceImage(sourceImageId),
      provenance,
      drive_backup: driveBackup,
      original_sha256: originalSha256,
      derivative_sha256: derivativeSha256
    });
  } catch (error) {
    return jsonError(error);
  }
}
