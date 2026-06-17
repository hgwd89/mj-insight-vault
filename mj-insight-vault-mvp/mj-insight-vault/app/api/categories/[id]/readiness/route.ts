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
    const { data, error } = await supabaseAdmin
      .from('category_analysis_readiness_view')
      .select('*')
      .eq('category_id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return Response.json({ error: 'category not found' }, { status: 404 });
    return Response.json({ category: data });
  } catch (error) {
    return jsonError(error);
  }
}
