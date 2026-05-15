import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;
    const { data: batch, error: batchError } = await supabaseAdmin.from('upload_batches').select('*').eq('id', id).single();
    if (batchError) throw batchError;
    const { data: images, error: imageError } = await supabaseAdmin.from('source_images').select('*').eq('batch_id', id).order('created_at');
    if (imageError) throw imageError;
    const { data: articles, error: articleError } = await supabaseAdmin.from('articles').select('*').eq('batch_id', id).order('article_index');
    if (articleError) throw articleError;
    return Response.json({ batch, images, articles });
  } catch (error) {
    return jsonError(error);
  }
}
