import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;

    const [{ data: batch, error: batchError }, { data: images, error: imageError }] = await Promise.all([
      supabaseAdmin
        .from('upload_batches')
        .select('id,memo,image_count,status,created_at,updated_at')
        .eq('id', id)
        .single(),
      supabaseAdmin
        .from('source_images')
        .select('id,batch_id,file_name,storage_path,mime_type,ocr_status,ocr_text_raw,error_message,created_at')
        .eq('batch_id', id)
        .order('created_at', { ascending: true })
    ]);

    if (batchError) throw batchError;
    if (imageError) throw imageError;

    return Response.json({ mode: 'ocr_only', batch, images: images || [] });
  } catch (error) {
    return jsonError(error);
  }
}
