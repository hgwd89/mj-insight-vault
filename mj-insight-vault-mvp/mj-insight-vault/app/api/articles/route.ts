import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const HIDDEN_STATUSES = new Set(['deleted', 'excluded', 'rejected']);
const PAGE_SIZE = 1000;
const SELECT = '*, article_tags(tag_type, tag_name), source_images(id, file_name, storage_path, mime_type)';

type ArticleRow = { status?: string | null; article_tags?: { tag_name: string }[] };

function isVisibleArticle(article: ArticleRow) {
  return !article.status || !HIDDEN_STATUSES.has(article.status);
}

async function fetchAllArticles(q: string) {
  const rows: ArticleRow[] = [];
  let from = 0;

  for (;;) {
    let query = supabaseAdmin
      .from('articles')
      .select(SELECT)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (q) {
      query = query.or(`headline.ilike.%${q}%,ocr_text.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    rows.push(...((data || []) as ArticleRow[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);

    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    const status = url.searchParams.get('status') || 'active';

    const data = await fetchAllArticles(q);

    let filtered = status === 'deleted'
      ? data.filter((article) => article.status === 'deleted')
      : data.filter(isVisibleArticle);

    if (tag) {
      filtered = filtered.filter((article) =>
        (article.article_tags || []).some((t: { tag_name: string }) => t.tag_name === tag)
      );
    }

    return Response.json({
      articles: filtered,
      total_fetched: data.length,
      total_visible: filtered.length,
      page_size: PAGE_SIZE,
      limit_removed: true
    });
  } catch (error) {
    return jsonError(error);
  }
}
