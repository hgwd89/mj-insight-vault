import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    let query = supabaseAdmin.from('articles').select('*, article_tags(tag_type, tag_name)').order('created_at', { ascending: false }).limit(100);
    if (q) query = query.or(`headline.ilike.%${q}%,ocr_text.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    const filtered = tag ? (data || []).filter((a) => (a.article_tags || []).some((t: { tag_name: string }) => t.tag_name === tag)) : data;
    return Response.json({ articles: filtered });
  } catch (error) {
    return jsonError(error);
  }
}
