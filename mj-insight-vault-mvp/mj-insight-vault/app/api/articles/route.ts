import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const HIDDEN_STATUSES = new Set(['deleted', 'excluded', 'rejected']);

function isVisibleArticle(article: { status?: string | null }) {
  return !article.status || !HIDDEN_STATUSES.has(article.status);
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);

    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    const status = url.searchParams.get('status') || 'active';

    let query = supabaseAdmin
      .from('articles')
      .select('*, article_tags(tag_type, tag_name), source_images(id, file_name, storage_path, mime_type)')
      .order('created_at', { ascending: false })
      .limit(300);

    if (q) {
      query = query.or(`headline.ilike.%${q}%,ocr_text.ilike.%${q}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    let filtered = status === 'deleted'
      ? (data || []).filter((article) => article.status === 'deleted')
      : (data || []).filter(isVisibleArticle);

    if (tag) {
      filtered = filtered.filter((article) =>
        (article.article_tags || []).some((t: { tag_name: string }) => t.tag_name === tag)
      );
    }

    return Response.json({ articles: filtered });
  } catch (error) {
    return jsonError(error);
  }
}
