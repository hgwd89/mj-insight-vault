import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { backupImageToGoogleDrive } from '@/lib/googleDriveBackup';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_BYTES = 3.5 * 1024 * 1024;

function isHeicFile(file: File) {
  const lowerName = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return type.includes('heic') || type.includes('heif') || lowerName.endsWith('.heic') || lowerName.endsWith('.heif');
}

function getMimeType(file: File) {
  const fileName = file.name || '';
  const lowerName = fileName.toLowerCase();

  if (file.type) return file.type;
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';

  return 'image/jpeg';
}

function getExtension(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

async function updateBatchStatus(batchId: string, status: string) {
  const first = await supabaseAdmin
    .from('upload_batches')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', batchId);

  if (!first.error) return;

  const fallback = await supabaseAdmin
    .from('upload_batches')
    .update({ status })
    .eq('id', batchId);

  if (fallback.error) throw fallback.error;
}

function appendBackupMessage(base: string, backup: { ok: boolean; skipped?: boolean; file_id?: string; error?: string }) {
  if (backup.skipped) return base;
  if (backup.ok) return `${base}; drive_file_id=${backup.file_id || ''}`;
  return `${base}; drive_backup_error=${backup.error || 'unknown'}`;
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const form = await req.formData();
    const batchId = String(form.get('batch_id') || '').trim();
    const index = Number(form.get('index') || 0);
    const fallbackArticleDate = String(form.get('article_date') || '').trim();
    const file = form.get('file');

    if (!batchId) return Response.json({ error: 'batch_id is required' }, { status: 400 });
    if (!(file instanceof File)) return Response.json({ error: 'file is required' }, { status: 400 });
    if (isHeicFile(file)) return Response.json({ error: `HEIC/HEIF files are not supported: ${file.name}` }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return Response.json({ error: `File is too large after compression. Limit is 3.5MB: ${file.name}` }, { status: 400 });

    const { data: batch, error: batchError } = await supabaseAdmin
      .from('upload_batches')
      .select('id')
      .eq('id', batchId)
      .single();

    if (batchError) throw batchError;
    if (!batch) return Response.json({ error: 'batch not found' }, { status: 404 });

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = getMimeType(file);
    const ext = getExtension(mimeType);
    const safeIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1;
    const displayFileName = file.name || `${String(safeIndex).padStart(2, '0')}.${ext}`;
    const storagePath = `${batchId}/${String(safeIndex).padStart(2, '0')}_${crypto.randomUUID()}.${ext}`;

    const upload = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
      contentType: mimeType,
      upsert: false
    });

    if (upload.error) throw upload.error;

    const driveBackup = await backupImageToGoogleDrive({
      buffer,
      fileName: displayFileName,
      mimeType,
      batchId,
      index: safeIndex
    });

    const baseMessage = fallbackArticleDate ? `queued; article_date=${fallbackArticleDate}` : 'queued';

    const { data: image, error: imageError } = await supabaseAdmin
      .from('source_images')
      .insert({
        batch_id: batchId,
        file_name: displayFileName,
        storage_path: storagePath,
        mime_type: mimeType,
        ocr_status: 'queued',
        error_message: appendBackupMessage(baseMessage, driveBackup)
      })
      .select('*')
      .single();

    if (imageError) throw imageError;

    await updateBatchStatus(batchId, 'queued');

    return Response.json({ image, drive_backup: driveBackup });
  } catch (error) {
    return jsonError(error);
  }
}
