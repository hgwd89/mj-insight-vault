import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;

    const { data: article, error } = await supabaseAdmin
      .from('articles')
      .select('*, article_tags(*), source_images(storage_path, file_name)')
      .eq('id', id)
      .single();

    if (error) throw error;

    return Response.json({ article });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const body = await req.json();

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if ('headline' in body) update.headline = body.headline;
    if ('status' in body) update.status = body.status;
    if ('manual_analysis' in body) update.manual_analysis = body.manual_analysis;

    const { data, error } = await supabaseAdmin
      .from('articles')
      .update(update)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    return Response.json({ article: data });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const action = new URL(req.url).searchParams.get('action');
    const nextStatus = action === 'restore' ? 'ocr_done' : 'deleted';

    const { data, error } = await supabaseAdmin
      .from('articles')
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    return Response.json({ article: data });
  } catch (error) {
    return jsonError(error);
  }
}
