import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const HIDDEN_STATUSES = new Set(['deleted', 'excluded', 'rejected']);
const PAGE_SIZE = 1000;
const SELECT = '*, article_tags(tag_type, tag_name), source_images(id, file_name, storage_path, mime_type)';

type ArticleRow = {
  id?: string;
  headline?: string | null;
  article_date?: string | null;
  ocr_text?: string | null;
  status?: string | null;
  created_at?: string | null;
  article_tags?: { tag_type?: string | null; tag_name?: string | null }[];
  search_score?: number;
  search_reason?: string;
};

function isVisibleArticle(article: ArticleRow) {
  return !article.status || !HIDDEN_STATUSES.has(article.status);
}

function normalize(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[「」『』【】\[\]（）()、。,.，．・:：;；!！?？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: unknown) {
  return normalize(value).replace(/\s+/g, '');
}

function terms(query: string) {
  const normalized = normalize(query);
  const rawTerms = normalized.split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const compactQuery = compact(query);
  const extra = compactQuery && !rawTerms.includes(compactQuery) ? [compactQuery] : [];
  return Array.from(new Set([...rawTerms, ...extra])).filter((term) => term.length >= 2).slice(0, 12);
}

function articleHaystacks(article: ArticleRow) {
  const tagText = (article.article_tags || []).map((tag) => `${tag.tag_type || ''} ${tag.tag_name || ''}`).join(' ');
  const headline = normalize(article.headline);
  const date = normalize(article.article_date);
  const tags = normalize(tagText);
  const body = normalize(article.ocr_text).slice(0, 12000);
  return {
    headline,
    date,
    tags,
    body,
    compactHeadline: compact(article.headline),
    compactBody: compact(article.ocr_text).slice(0, 12000),
    all: `${headline} ${date} ${tags} ${body}`
  };
}

function scoreArticle(article: ArticleRow, query: string) {
  const q = normalize(query);
  const cq = compact(query);
  const queryTerms = terms(query);
  if (!q && !cq) return { score: 0, matched: true, reason: '' };

  const h = articleHaystacks(article);
  let score = 0;
  const reasons: string[] = [];
  let matchedTerms = 0;

  if (q && h.headline.includes(q)) { score += 120; reasons.push('headline_exact'); }
  if (cq && h.compactHeadline.includes(cq)) { score += 110; reasons.push('headline_compact_exact'); }
  if (q && h.tags.includes(q)) { score += 70; reasons.push('tag_exact'); }
  if (q && h.body.includes(q)) { score += 45; reasons.push('body_exact'); }
  if (cq && h.compactBody.includes(cq)) { score += 40; reasons.push('body_compact_exact'); }
  if (q && h.date.includes(q)) { score += 35; reasons.push('date_exact'); }

  for (const term of queryTerms) {
    let termScore = 0;
    const compactTerm = term.replace(/\s+/g, '');
    if (h.headline.includes(term) || h.compactHeadline.includes(compactTerm)) termScore += 30;
    if (h.tags.includes(term)) termScore += 18;
    if (h.date.includes(term)) termScore += 12;
    if (h.body.includes(term) || h.compactBody.includes(compactTerm)) termScore += 7;
    if (termScore > 0) {
      matchedTerms += 1;
      score += termScore;
    }
  }

  const enoughTermCoverage = queryTerms.length <= 1
    ? matchedTerms > 0
    : matchedTerms >= Math.ceil(queryTerms.length * 0.6);
  const phraseMatched = score >= 40 && reasons.length > 0;
  const matched = phraseMatched || enoughTermCoverage;

  return { score, matched, reason: reasons.join(',') || `${matchedTerms}/${queryTerms.length} terms` };
}

function rankArticles(rows: ArticleRow[], q: string) {
  const query = q.trim();
  if (!query) return rows;

  return rows
    .map((article) => {
      const scored = scoreArticle(article, query);
      return { ...article, search_score: scored.score, search_reason: scored.reason, __matched: scored.matched } as ArticleRow & { __matched: boolean };
    })
    .filter((article) => article.__matched)
    .sort((a, b) => {
      const scoreDiff = Number(b.search_score || 0) - Number(a.search_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(b.article_date || b.created_at || '').localeCompare(String(a.article_date || a.created_at || ''));
    })
    .map(({ __matched, ...article }) => article);
}

async function fetchAllArticles() {
  const rows: ArticleRow[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('articles')
      .select(SELECT)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

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

    const data = await fetchAllArticles();

    let filtered = status === 'deleted'
      ? data.filter((article) => article.status === 'deleted')
      : data.filter(isVisibleArticle);

    if (tag) {
      filtered = filtered.filter((article) =>
        (article.article_tags || []).some((t) => t.tag_name === tag)
      );
    }

    const ranked = rankArticles(filtered, q);

    return Response.json({
      articles: ranked,
      total_fetched: data.length,
      total_visible: filtered.length,
      total_matched: ranked.length,
      page_size: PAGE_SIZE,
      limit_removed: true,
      search_mode: q ? 'ranked_multi_field_lexical' : 'none',
      search_query: q
    });
  } catch (error) {
    return jsonError(error);
  }
}
