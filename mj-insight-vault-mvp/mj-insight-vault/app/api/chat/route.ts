import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText, getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

type TargetScope = 'all' | 'recent_30d' | 'latest_batch';
type OutputTemplate = 'auto' | 'trend' | 'why' | 'research' | 'proposal' | 'method' | 'news_list';

type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type ArticleContext = {
  id: string;
  batch_id?: string | null;
  headline: string | null;
  article_date?: string | null;
  ocr_text: string | null;
  status?: string | null;
  created_at?: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};

type EvidenceItem = {
  insight?: string;
  claim?: string;
  article_id?: string;
  headline?: string | null;
  article_date?: string | null;
  excerpt?: string;
  confidence?: 'high' | 'medium' | 'low' | string;
};

const ARTICLE_SELECT =
  'id, batch_id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)';

const HIDDEN_STATUSES = new Set(['deleted', 'excluded', 'rejected']);
const DEFAULT_CHAT_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];

function getSelectableModels() {
  const fromEnv = (process.env.OPENAI_CHAT_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return Array.from(new Set([TEXT_MODEL, ...fromEnv, ...DEFAULT_CHAT_MODELS].filter(Boolean)));
}

function normalizeModel(value: unknown) {
  const models = getSelectableModels();
  return typeof value === 'string' && models.includes(value) ? value : TEXT_MODEL;
}

function normalizeTargetScope(value: unknown): TargetScope {
  if (value === 'recent_30d' || value === 'latest_batch') return value;
  return 'all';
}

function normalizeOutputTemplate(value: unknown): OutputTemplate {
  if (
    value === 'trend' ||
    value === 'why' ||
    value === 'research' ||
    value === 'proposal' ||
    value === 'method' ||
    value === 'news_list'
  ) return value;
  return 'auto';
}

function normalizeConversation(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((turn) => {
      if (!turn || typeof turn !== 'object') return null;
      const record = turn as Record<string, unknown>;
      const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null;
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      if (!role || !content) return null;
      return { role, content: content.slice(0, 6000) };
    })
    .filter(Boolean)
    .slice(-8) as ConversationTurn[];
}

function isActiveArticle(article: ArticleContext) {
  return !article.status || !HIDDEN_STATUSES.has(article.status);
}

function uniqueArticles(articles: ArticleContext[]) {
  const seen = new Set<string>();
  return articles.filter((article) => {
    if (!article.id || seen.has(article.id)) return false;
    seen.add(article.id);
    return true;
  });
}

function escapeLike(value: string) {
  return value.replace(/[%_,]/g, ' ').trim();
}

function extractKeywords(query: string) {
  const keywords = new Set<string>();
  const normalized = query.replace(/[、。・「」『』（）()]/g, ' ');

  const categoryMap: Array<[RegExp, string[]]> = [
    [/食品|飲料|外食|冷食|スーパー|コンビニ|菓子|ヨーグルト|惣菜|弁当|ポッポ|ローソン|飲むヨーグレット/, ['食品', '飲料', '外食', '冷食', 'スーパー', 'コンビニ', '菓子', 'ヨーグルト', '惣菜', '弁当', 'ローソン']],
    [/化粧品|美容|コスメ|スキンケア|ヘアケア|メイク/, ['化粧品', '美容', 'コスメ', 'スキンケア', 'ヘアケア', 'メイク']],
    [/AI|人工知能|生成AI|ChatGPT|チャットGPT/, ['AI', '人工知能', '生成AI', 'ChatGPT']],
    [/推し|オタク|ファン|投げ銭|匿名|相談|SNS|Z世代|mond|モンド/, ['推し', 'オタク', 'ファン', '投げ銭', '匿名', '相談', 'SNS', 'Z世代', 'mond', 'モンド']],
    [/N1|探索|投影|BOT|リフレクション|定量|調査/, ['N1', '探索', '投影', 'BOT', 'リフレクション', '定量', '調査']]
  ];

  for (const [pattern, words] of categoryMap) {
    if (pattern.test(query)) words.forEach((word) => keywords.add(word));
  }

  normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => word.replace(/(だけ|関連|記事|分析|して|出して|整理|業界|今月分|今月|リサーチ|課題|テーマ|向いている|回すべき|ください)/g, ''))
    .filter((word) => word.length >= 2)
    .slice(0, 8)
    .forEach((word) => keywords.add(word));

  return Array.from(keywords).map(escapeLike).filter(Boolean).slice(0, 12);
}

async function getLatestBatchId() {
  const { data, error } = await supabaseAdmin
    .from('upload_batches')
    .select('id, status, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Latest upload lookup failed:', error);
    return null;
  }

  return (data || []).find((batch) => !HIDDEN_STATUSES.has(batch.status))?.id || null;
}

function filterByScope(articles: ArticleContext[], targetScope: TargetScope, latestBatchId: string | null) {
  if (targetScope === 'recent_30d') {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return articles.filter((article) => article.created_at && new Date(article.created_at).getTime() >= cutoff);
  }

  if (targetScope === 'latest_batch') {
    if (!latestBatchId) return [];
    return articles.filter((article) => article.batch_id === latestBatchId);
  }

  return articles;
}

async function fetchRecentArticles(limit = 40): Promise<ArticleContext[]> {
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select(ARTICLE_SELECT)
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) throw error;

  return ((data || []) as ArticleContext[]).filter(isActiveArticle).slice(0, limit);
}

async function fetchKeywordArticles(query: string): Promise<ArticleContext[]> {
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];

  const clauses = keywords.flatMap((keyword) => [`headline.ilike.%${keyword}%`, `ocr_text.ilike.%${keyword}%`]);

  const { data, error } = await supabaseAdmin
    .from('articles')
    .select(ARTICLE_SELECT)
    .or(clauses.join(','))
    .order('created_at', { ascending: false })
    .limit(150);

  if (error) {
    console.error('Keyword article retrieval failed:', error);
    return [];
  }

  return ((data || []) as ArticleContext[]).filter(isActiveArticle);
}

async function fetchEmbeddingArticles(query: string): Promise<ArticleContext[]> {
  const embedding = await embedText(query);
  if (!embedding) return [];

  const { data, error } = await supabaseAdmin.rpc('match_articles', {
    query_embedding: embedding,
    match_count: 30
  });

  if (error) {
    console.error('Embedding article retrieval failed:', error);
    return [];
  }

  const ids = (data || []).map((r: { article_id?: string }) => r.article_id).filter(Boolean) as string[];

  if (!ids.length) return [];

  const { data: articles, error: articleError } = await supabaseAdmin
    .from('articles')
    .select(ARTICLE_SELECT)
    .in('id', ids);

  if (articleError) throw articleError;

  const active = ((articles || []) as ArticleContext[]).filter(isActiveArticle);
  const byId = new Map(active.map((article) => [article.id, article]));

  return ids.map((id) => byId.get(id)).filter(Boolean) as ArticleContext[];
}

async function retrieveArticles(query: string, targetScope: TargetScope): Promise<ArticleContext[]> {
  const latestBatchId = targetScope === 'latest_batch' ? await getLatestBatchId() : null;
  const keywordArticles = filterByScope(await fetchKeywordArticles(query), targetScope, latestBatchId);
  const embeddingArticles = filterByScope(await fetchEmbeddingArticles(query), targetScope, latestBatchId);
  const recentArticles = filterByScope(await fetchRecentArticles(80), targetScope, latestBatchId);

  return uniqueArticles([...keywordArticles, ...embeddingArticles, ...recentArticles]).slice(0, 40);
}

function templateInstruction(outputTemplate: OutputTemplate) {
  switch (outputTemplate) {
    case 'trend':
      return '生活者トレンド整理として、変化の兆し、背景、生活者心理、企業への示唆、調査仮説を分けてください。';
    case 'why':
      return 'WHY分析として、表層事象から最低5段階で理由を掘り下げ、最後に本質仮説を出してください。';
    case 'research':
      return 'リサーチ課題化として、調査目的、検証仮説、対象者条件、聞くべき論点、適した手法を出してください。';
    case 'proposal':
      return '提案書ネタとして、提案タイトル、クライアント課題、使える記事根拠、提案骨子、勝ち筋を出してください。';
    case 'method':
      return '手法適性評価として、N1探索、ビジュアル投影、BOT調査、リフレクション、定量調査のどれに向くかを根拠付きで評価してください。';
    case 'news_list':
      return 'ニュース一覧として、記事ごとに日付、見出し、主要事実、生活者変化の読み、使い道を表形式で出してください。';
    default:
      return '質問内容に最も合う形式で、実務で使える分析にしてください。';
  }
}

function extractExcerpt(article: ArticleContext, query: string) {
  const text = article.ocr_text || '';
  if (!text) return '';

  const keywords = extractKeywords(query);
  const hit = keywords.find((keyword) => text.includes(keyword));

  if (!hit) return text.slice(0, 160);

  const index = text.indexOf(hit);
  const start = Math.max(0, index - 60);
  return text.slice(start, start + 180);
}

function fallbackCards(articles: ArticleContext[]) {
  return articles.slice(0, 12).map((a) => ({
    article_id: a.id,
    headline: a.headline,
    article_date: a.article_date,
    reason: '分析対象候補'
  }));
}

function normalizeEvidence(value: unknown, articles: ArticleContext[], query: string): EvidenceItem[] {
  const byId = new Map(articles.map((article) => [article.id, article]));
  const rawItems = Array.isArray(value) ? value : [];
  const normalized: EvidenceItem[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as EvidenceItem;
    const article = item.article_id ? byId.get(item.article_id) : undefined;
    if (!article) continue;

    normalized.push({
      insight: String(item.insight || item.claim || '').slice(0, 220),
      claim: String(item.claim || item.insight || '').slice(0, 220),
      article_id: article.id,
      headline: article.headline,
      article_date: article.article_date || '日付不明',
      excerpt: String(item.excerpt || extractExcerpt(article, query)).slice(0, 240),
      confidence: item.confidence || 'medium'
    });
  }

  if (normalized.length) return normalized.slice(0, 20);

  return articles.slice(0, 8).map((article) => ({
    insight: '分析対象候補',
    claim: 'この回答の根拠候補として参照',
    article_id: article.id,
    headline: article.headline,
    article_date: article.article_date || '日付不明',
    excerpt: extractExcerpt(article, query),
    confidence: 'low'
  }));
}

async function analyze(
  query: string,
  articles: ArticleContext[],
  model: string,
  targetScope: TargetScope,
  outputTemplate: OutputTemplate,
  conversation: ConversationTurn[]
) {
  const openai = getOpenAI();

  if (!articles.length) {
    return {
      answer_text: '指定範囲に分析対象の記事がありません。対象範囲を「全記事」に変えるか、不要記事化されていないか確認してください。',
      table: [],
      cards: [],
      evidence: [],
      insights: [],
      target_scope: targetScope,
      output_template: outputTemplate,
      model_used: model,
      related_article_count: 0
    };
  }

  const cards = fallbackCards(articles);

  if (!openai) {
    return {
      answer_text: `OPENAI_API_KEYが未設定のため、関連候補${articles.length}件のみ返します。`,
      table: [],
      cards,
      evidence: normalizeEvidence([], articles, query),
      insights: [],
      target_scope: targetScope,
      output_template: outputTemplate,
      model_used: model,
      related_article_count: articles.length
    };
  }

  const articleContext = articles.map((a, i) => ({
    no: i + 1,
    article_id: a.id,
    batch_id: a.batch_id,
    headline: a.headline,
    article_date: a.article_date || '日付不明',
    status: a.status || 'active',
    created_at: a.created_at,
    tags: (a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`),
    text: (a.ocr_text || '').slice(0, 3000)
  }));

  const system = [
    'あなたはマーケティングリサーチの上級コンサルタントです。',
    '蓄積されたMJ記事候補を根拠に、生活者トレンド、業界課題、リサーチ課題、手法適性を分析します。',
    '直前までの会話がある場合は、その文脈を踏まえて追加質問に答えてください。',
    templateInstruction(outputTemplate),
    '回答は必ずJSONで返します。',
    '必ず answer_text, table, cards, evidence, insights を含めてください。',
    'cardsには根拠記事IDを必ず含めてください。',
    'evidenceは配列です。各要素は insight, claim, article_id, headline, article_date, excerpt, confidence を必ず含めてください。',
    'insightsは配列です。各要素は title, finding, why_it_matters, evidence_article_ids を含めてください。',
    '各重要主張には必ず根拠記事IDを紐づけてください。根拠のない主張は「仮説」と明記してください。',
    '記事日付が article_date にある場合は必ず使い、ない場合は「日付不明」と明記してください。',
    '記事にない内容を断定しないでください。',
    '不確かな点は「仮説」と明記してください。',
    '回答は日本語で、実務で使える粒度にしてください。'
  ].join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        ...conversation,
        {
          role: 'user',
          content: JSON.stringify({ user_query: query, target_scope: targetScope, output_template: outputTemplate, article_count: articleContext.length, articles: articleContext }, null, 2)
        }
      ]
    });

    const raw = completion.choices[0]?.message.content || '{}';

    try {
      const parsed = JSON.parse(raw);
      const evidence = normalizeEvidence(parsed.evidence, articles, query);
      return {
        answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : typeof parsed.summary === 'string' ? parsed.summary : raw,
        table: Array.isArray(parsed.table) ? parsed.table : [],
        cards: Array.isArray(parsed.cards) ? parsed.cards : cards,
        insights: Array.isArray(parsed.insights) ? parsed.insights : [],
        ...parsed,
        evidence,
        target_scope: targetScope,
        output_template: outputTemplate,
        model_used: model,
        related_article_count: articles.length
      };
    } catch {
      return { answer_text: raw, table: [], cards, evidence: normalizeEvidence([], articles, query), insights: [], target_scope: targetScope, output_template: outputTemplate, model_used: model, related_article_count: articles.length };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    console.error('OpenAI analysis failed:', error);
    return {
      answer_text: `OpenAI分析でエラーが出ました。関連候補${articles.length}件は取得できています。エラー: ${message}`,
      table: [],
      cards,
      evidence: normalizeEvidence([], articles, query),
      insights: [],
      target_scope: targetScope,
      output_template: outputTemplate,
      model_used: model,
      related_article_count: articles.length
    };
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const body = await req.json();
    const { query } = body;
    const model = normalizeModel(body.model);
    const targetScope = normalizeTargetScope(body.target_scope);
    const outputTemplate = normalizeOutputTemplate(body.output_template);
    const conversation = normalizeConversation(body.conversation);

    if (!query || typeof query !== 'string') {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

    const related = await retrieveArticles(query, targetScope);
    const answer = await analyze(query, related, model, targetScope, outputTemplate, conversation);

    let report = null;
    let report_error = '';

    try {
      const { data, error } = await supabaseAdmin
        .from('chat_reports')
        .insert({
          user_query: query,
          answer_text: answer.answer_text,
          answer_json: answer,
          related_article_ids: related.map((a) => a.id)
        })
        .select('*')
        .single();

      if (error) throw error;
      report = data;
    } catch (error) {
      report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
      console.error('chat_reports insert failed:', error);
    }

    return Response.json({ report, report_error, related_articles: related, selectable_models: getSelectableModels(), answer });
  } catch (error) {
    return jsonError(error);
  }
}
