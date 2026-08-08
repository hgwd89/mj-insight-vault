import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function extensionFor(fileName: string, mimeType: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jpeg')) return 'jpeg';
  if (lower.endsWith('.jpg')) return 'jpg';
  if (lower.endsWith('.png')) return 'png';
  if (lower.endsWith('.webp')) return 'webp';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const batchId = String(body.batch_id || '').trim();
    const fileName = String(body.file_name || '').trim();
    const mimeType = String(body.mime_type || '').trim().toLowerCase();
    const fileSize = Number(body.file_size || 0);
    const originalSha256 = String(body.original_sha256 || '').trim().toLowerCase();
    const rawIndex = Number(body.index || 0);
    const safeIndex = Number.isFinite(rawIndex) && rawIndex > 0 ? Math.floor(rawIndex) : 1;

    if (!batchId) return Response.json({ error: 'batch_id is required' }, { status: 400 });
    if (!fileName) return Response.json({ error: 'file_name is required' }, { status: 400 });
    if (!ALLOWED_MIME_TYPES.has(mimeType)) return Response.json({ error: `Unsupported original image MIME type: ${mimeType || 'unknown'}` }, { status: 400 });
    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_ORIGINAL_BYTES) {
      return Response.json({ error: `Original image size is invalid or exceeds ${MAX_ORIGINAL_BYTES} bytes.` }, { status: 400 });
    }
    if (!/^[0-9a-f]{64}$/.test(originalSha256)) return Response.json({ error: 'original_sha256 is required' }, { status: 400 });

    const { data: batch, error: batchError } = await supabaseAdmin
      .from('upload_batches')
      .select('id')
      .eq('id', batchId)
      .single();
    if (batchError) throw batchError;
    if (!batch) return Response.json({ error: 'batch not found' }, { status: 404 });

    const { data: existingSlot, error: slotError } = await supabaseAdmin.rpc('source_image_ingest_slot_status_v4', {
      p_batch_id: batchId,
      p_ingest_slot: safeIndex
    });
    if (slotError) throw slotError;
    const existing = Array.isArray(existingSlot) ? existingSlot[0] : null;
    if (existing?.source_image_id) {
      const { data: provenance, error: provenanceError } = await supabaseAdmin
        .from('source_image_ingest_provenance_v2')
        .select('original_sha256,original_storage_path,quality_status')
        .eq('source_image_id', existing.source_image_id)
        .maybeSingle();
      if (provenanceError) throw provenanceError;
      if (provenance?.quality_status === 'passed') {
        if (provenance.original_sha256 !== originalSha256) {
          return Response.json({ error: 'This batch slot is already registered to a different original image.' }, { status: 409 });
        }
        return Response.json({
          already_registered: true,
          source_image_id: existing.source_image_id,
          path: provenance.original_storage_path,
          original_sha256: provenance.original_sha256
        });
      }
    }

    const ext = extensionFor(fileName, mimeType);
    const path = `${batchId}/original/${String(safeIndex).padStart(2, '0')}_${originalSha256}.${ext}`;
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(path, { upsert: true });
    if (error) throw error;
    if (!data?.signedUrl || !data?.token) throw new Error('Supabase did not return a signed upload URL and token.');

    return Response.json({
      path,
      signed_url: data.signedUrl,
      token: data.token,
      original_sha256: originalSha256,
      expires_in_seconds: 7200
    });
  } catch (error) {
    return jsonError(error);
  }
}
