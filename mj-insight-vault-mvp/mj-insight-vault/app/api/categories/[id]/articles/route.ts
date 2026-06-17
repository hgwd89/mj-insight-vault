import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const params = await ctx.params;
    const id = params.id || '';
    if (!id) return Response.json({ error: 'category id is required' }, { status: 400 });
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 80)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

    const { data, error, count } = await supabaseAdmin
      .from('article_category_memberships')
      .select('article_id, score, confidence, match_terms, reason, articles(id, headline, article_date, ocr_text, created_at)', { count: 'exact' })
      .eq('category_id', id)
      .order('score', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return Response.json({ category_id: id, count: count || 0, offset, limit, articles: data || [] });
  } catch (error) {
    return jsonError(error);
  }
}
