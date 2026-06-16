import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText } from '@/lib/openai';

export type SearchableArticle = {
  id?: string;
  headline?: string | null;
  article_date?: string | null;
  ocr_text?: string | null;
  status?: string | null;
  created_at?: string | null;
  article_tags?: { tag_type?: string | null; tag_name?: string | null }[];
  search_score?: number;
  lexical_score?: number;
  semantic_score?: number;
  semantic_similarity?: number;
  search_reason?: string;
  search_mode?: string;
};

type MatchArticleRow = {
  article_id: string;
  similarity: number;
};

type ScoredArticle = SearchableArticle & { __matched: boolean };

const SYNONYM_GROUPS = [
  ['値上げ', '価格上昇', '価格改定', '物価高', 'インフレ', '高騰', '実質値上げ'],
  ['節約', '倹約', '防衛消費', '低価格', '安い', 'コスパ', 'タイパ', '買い控え'],
  ['若者', 'Z世代', '学生', '20代', '若年層', '大学生', '高校生'],
  ['高齢者', 'シニア', 'シルバー', '中高年', '60代', '70代'],
  ['共働き', '子育て', '育児', 'ファミリー', '家族', '親子', '母親', '父親'],
  ['外食', '飲食店', 'レストラン', '居酒屋', 'カフェ', '中食', 'テイクアウト'],
  ['食品', '食', 'フード', '惣菜', '弁当', '冷凍食品', '菓子', '飲料'],
  ['小売', '店頭', '店舗', 'スーパー', 'コンビニ', '百貨店', 'ドラッグストア'],
  ['美容', '化粧品', 'スキンケア', 'メイク', '肌', 'ヘアケア', 'コスメ'],
  ['健康', 'ウェルビーイング', '睡眠', '運動', 'セルフケア', '医療', '予防'],
  ['AI', '生成AI', '人工知能', 'DX', 'デジタル', '自動化', 'チャットボット'],
  ['サステナブル', '環境', 'エコ', '脱炭素', '再利用', 'リサイクル', '詰め替え'],
  ['訪日', 'インバウンド', '観光', '旅行', 'ホテル', '外国人客'],
  ['推し活', 'ファン', 'オタク', 'キャラクター', 'アニメ', 'ゲーム'],
  ['中古', 'リユース', 'リセール', 'フリマ', 'シェア', 'レンタル'],
  ['ペット', '犬', '猫', '動物', 'ペット用品'],
  ['物流', '配送', '宅配', 'ラストワンマイル', 'EC', '通販'],
  ['人手不足', '採用', '賃上げ', '働き方', '労働力', 'アルバイト'],
  ['地方', '地域', '商店街', '自治体', '郊外', '都市部'],
  ['体験', 'イベント', 'ポップアップ', '没入', '参加型', 'コミュニティ']
];

export function normalizeSearchText(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[「」『』【】\[\]（）()、。,.，．・:：;；!！?？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: unknown) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function baseTerms(query: string) {
  const normalized = normalizeSearchText(query);
  const rawTerms = normalized.split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const compactQuery = compact(query);
  const extra = compactQuery && !rawTerms.includes(compactQuery) ? [compactQuery] : [];
  return Array.from(new Set([...rawTerms, ...extra])).filter((term) => term.length >= 2).slice(0, 16);
}

function expandedTerms(query: string) {
  const terms = new Set(baseTerms(query));
  const normalized = compact(query);
  for (const group of SYNONYM_GROUPS) {
    const normalizedGroup = group.map((word) => compact(word));
    if (normalizedGroup.some((word) => normalized.includes(word) || word.includes(normalized))) {
      for (const word of group) terms.add(compact(word));
    }
  }
  return Array.from(terms).filter((term) => term.length >= 2).slice(0, 40);
}

function articleHaystacks(article: SearchableArticle) {
  const tagText = (article.article_tags || []).map((tag) => `${tag.tag_type || ''} ${tag.tag_name || ''}`).join(' ');
  const headline = normalizeSearchText(article.headline);
  const date = normalizeSearchText(article.article_date);
  const tags = normalizeSearchText(tagText);
  const body = normalizeSearchText(article.ocr_text).slice(0, 16000);
  return {
    headline,
    date,
    tags,
    body,
    compactHeadline: compact(article.headline),
    compactBody: compact(article.ocr_text).slice(0, 16000),
    compactTags: compact(tagText),
    all: `${headline} ${date} ${tags} ${body}`
  };
}

function lexicalScore(article: SearchableArticle, query: string) {
  const q = normalizeSearchText(query);
  const cq = compact(query);
  const queryTerms = expandedTerms(query);
  if (!q && !cq) return { score: 0, matched: true, reason: '' };

  const h = articleHaystacks(article);
  let score = 0;
  const reasons: string[] = [];
  let matchedTerms = 0;

  if (q && h.headline.includes(q)) { score += 150; reasons.push('headline_phrase'); }
  if (cq && h.compactHeadline.includes(cq)) { score += 140; reasons.push('headline_compact_phrase'); }
  if (q && h.tags.includes(q)) { score += 95; reasons.push('tag_phrase'); }
  if (cq && h.compactTags.includes(cq)) { score += 90; reasons.push('tag_compact_phrase'); }
  if (q && h.date.includes(q)) { score += 45; reasons.push('date_phrase'); }
  if (q && h.body.includes(q)) { score += 38; reasons.push('body_phrase'); }
  if (cq && h.compactBody.includes(cq)) { score += 34; reasons.push('body_compact_phrase'); }

  for (const term of queryTerms) {
    let termScore = 0;
    if (h.headline.includes(term) || h.compactHeadline.includes(term)) termScore += 34;
    if (h.tags.includes(term) || h.compactTags.includes(term)) termScore += 24;
    if (h.date.includes(term)) termScore += 10;
    if (h.body.includes(term) || h.compactBody.includes(term)) termScore += 8;
    if (termScore > 0) {
      matchedTerms += 1;
      score += termScore;
    }
  }

  const originalTerms = baseTerms(query);
  const enoughTermCoverage = originalTerms.length <= 1
    ? matchedTerms > 0
    : matchedTerms >= Math.ceil(originalTerms.length * 0.5);
  const phraseMatched = score >= 34 && reasons.length > 0;
  const matched = phraseMatched || enoughTermCoverage;

  return { score, matched, reason: reasons.join(',') || `${matchedTerms}/${queryTerms.length} expanded_terms` };
}

async function semanticScores(query: string) {
  const embedding = await embedText(query).catch(() => null);
  if (!embedding) return new Map<string, { similarity: number; score: number }>();

  const { data, error } = await supabaseAdmin.rpc('match_articles', {
    query_embedding: embedding,
    match_count: 300
  });

  if (error) return new Map<string, { similarity: number; score: number }>();

  const map = new Map<string, { similarity: number; score: number }>();
  for (const row of (data || []) as MatchArticleRow[]) {
    const similarity = Number(row.similarity || 0);
    if (!row.article_id || !Number.isFinite(similarity)) continue;
    if (similarity < 0.18) continue;
    const score = Math.max(0, Math.min(150, (similarity - 0.18) * 300));
    map.set(String(row.article_id), { similarity, score });
  }
  return map;
}

export async function rankArticlesHybrid(rows: SearchableArticle[], query: string) {
  const q = query.trim();
  if (!q) return { articles: rows, mode: 'none' };

  const semantic = await semanticScores(q);
  const scored = rows.map((article) => {
    const lexical = lexicalScore(article, q);
    const sem = article.id ? semantic.get(article.id) : undefined;
    const semanticScore = sem?.score || 0;
    const semanticStrongEnough = Number(sem?.similarity || 0) >= 0.24;
    const score = lexical.score + semanticScore;
    const matched = lexical.matched || semanticStrongEnough;
    const reasons = [lexical.reason, sem ? `semantic_${sem.similarity.toFixed(3)}` : ''].filter(Boolean).join(',');
    return {
      ...article,
      search_score: Math.round(score * 100) / 100,
      lexical_score: Math.round(lexical.score * 100) / 100,
      semantic_score: Math.round(semanticScore * 100) / 100,
      semantic_similarity: sem ? Math.round(sem.similarity * 10000) / 10000 : undefined,
      search_reason: reasons,
      search_mode: semantic.size ? 'hybrid_lexical_semantic' : 'ranked_lexical',
      __matched: matched
    } as ScoredArticle;
  });

  const articles = scored
    .filter((article) => article.__matched)
    .sort((a, b) => {
      const scoreDiff = Number(b.search_score || 0) - Number(a.search_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(b.article_date || b.created_at || '').localeCompare(String(a.article_date || a.created_at || ''));
    })
    .map(({ __matched, ...article }) => article);

  return { articles, mode: semantic.size ? 'hybrid_lexical_semantic' : 'ranked_lexical' };
}
