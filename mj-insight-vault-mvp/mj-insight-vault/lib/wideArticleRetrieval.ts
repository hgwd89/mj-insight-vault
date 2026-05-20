import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type WideArticle = {
  id: string;
  batch_id?: string | null;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
  status?: string | null;
  created_at?: string | null;
};

const PAGE_SIZE = 1000;
const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const SELECT = 'id, batch_id, headline, article_date, ocr_text, status, created_at';

function active(article: WideArticle) {
  return !article.status || !HIDDEN.has(article.status);
}

function uniq(rows: WideArticle[]) {
  const seen = new Set<string>();
  return rows.filter(active).filter((article) => {
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  });
}

export async function fetchAllWideArticles() {
  const rows: WideArticle[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('articles')
      .select(SELECT)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data || []) as WideArticle[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return uniq(rows);
}
