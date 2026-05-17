import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function normalizeImageCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const body = await req.json().catch(() => ({}));
    const memo = String(body.memo || '').trim();
    const articleDate = String(body.article_date || '').trim();
    const imageCount = normalizeImageCount(body.image_count);

    if (!imageCount) {
      return Response.json({ error: 'image_count is required' }, { status: 400 });
    }

    const { data: batch, error } = await supabaseAdmin
      .from('upload_batches')
      .insert({
        memo: articleDate ? `${memo}${memo ? '\n' : ''}article_date=${articleDate}` : memo,
        image_count: imageCount,
        status: 'queued'
      })
      .select('*')
      .single();

    if (error) throw error;

    return Response.json({ batch });
  } catch (error) {
    return jsonError(error);
  }
}
