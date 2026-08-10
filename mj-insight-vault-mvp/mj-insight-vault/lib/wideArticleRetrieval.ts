import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type WideArticle = {
  id: string;
  batch_id?: string | null;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
  article_type?: string | null;
  status?: string | null;
  created_at?: string | null;
};

const PAGE_SIZE = 1000;
const SELECT = 'id, batch_id, headline, article_date, ocr_text, article_type, status, created_at';

function uniq(rows: WideArticle[]) {
  const seen = new Set<string>();
  return rows.filter((article) => {
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  });
}

/**
 * The formal-corpus scan must use the database's authoritative formal corpus
 * predicate, not a looser application-side approximation. The view also
 * carries the provenance, deduplication, publication-date, clean-body and
 * hard-advertisement gates that are intentionally absent from raw `articles`.
 */
export async function fetchAllWideArticles() {
  const rows: WideArticle[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('formal_corpus_articles_v1')
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
