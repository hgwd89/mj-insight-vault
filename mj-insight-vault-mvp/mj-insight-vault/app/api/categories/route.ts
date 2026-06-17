import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const { data, error } = await supabaseAdmin
      .from('category_analysis_readiness_view')
      .select('*')
      .order('matched_article_count', { ascending: false });
    if (error) throw error;
    return Response.json({ categories: data || [] });
  } catch (error) {
    return jsonError(error);
  }
}
