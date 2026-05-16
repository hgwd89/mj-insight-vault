import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText, getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ArticleContext = {
  id: string;
  headline: string | null;
  ocr_text: string | null;
  status?: string | null;
  created_at?: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};

const ARTICLE_SELECT =
  'id, headline, ocr_text, status, created_at, article_tags(tag_type, tag_name)';

const EXCLUDED_STATUSES = ['deleted', 'excluded', 'rejected'];

function activeArticleQuery() {
  let query = supabaseAdmin.from('articles').select(ARTICLE_SELECT);

  for (const status of EXCLUDED_STATUSES) {
    query = query.neq('status', status);
  }

  return query;
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
    [
      /食品|飲料|外食|冷食|スーパー|コンビニ|菓子|ヨーグルト|惣菜|弁当/,
      ['食品', '飲料', '外食', '冷食', 'スーパー', 'コンビニ', '菓子', 'ヨーグルト', '惣菜', '弁当']
    ],
    [
      /化粧品|美容|コスメ|スキンケア|ヘアケア|メイク/,
      ['化粧品', '美容', 'コスメ', 'スキンケア', 'ヘアケア', 'メイク']
    ],
    [
      /AI|人工知能|生成AI|ChatGPT|チャットGPT/,
      ['AI', '人工知能', '生成AI', 'ChatGPT']
    ],
    [
      /推し|オタク|ファン|投げ銭|匿名|相談|SNS|Z世代/,
      ['推し', 'オタク', 'ファン', '投げ銭', '匿名', '相談', 'SNS', 'Z世代']
    ],
    [
      /N1|探索|投影|BOT|リフレクション|定量|調査/,
      ['N1', '探索', '投影', 'BOT', 'リフレクション', '定量', '調査']
    ]
  ];

  for (const [pattern, words] of categoryMap) {
    if (pattern.test(query)) {
      words.forEach((word) => keywords.add(word));
    }
  }

  normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) =>
      word.replace(
        /(だけ|関連|記事|分析|して|出して|整理|業界|今月分|今月|リサーチ|課題|テーマ|向いている|回すべき)/g,
        ''
      )
    )
    .filter((word) => word.length >= 2)
    .slice(0, 8)
    .forEach((word) => keywords.add(word));

  return Array.from(keywords).map(escapeLike).filter(Boolean).slice(0, 12);
}

async function fetchRecentArticles(limit = 32): Promise<ArticleContext[]> {
  const { data, error } = await activeArticleQuery()
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data || []) as ArticleContext[];
}

async function fetchKeywordArticles(query: string): Promise<ArticleContext[]> {
  const keywords = extractKeywords(query);

  if (!keywords.length) return [];

  const clauses = keywords.flatMap((keyword) => [
    `headline.ilike.%${keyword}%`,
    `ocr_text.ilike.%${keyword}%`
  ]);

  const { data, error } = await activeArticleQuery()
    .or(clauses.join(','))
    .order('created_at', { ascending: false })
    .limit(32);

  if (error) {
    console.error('Keyword article retrieval failed:', error);
    return [];
  }

  return (data || []) as ArticleContext[];
}

async function fetchEmbeddingArticles(query: string): Promise<ArticleContext[]> {
  const embedding = await embedText(query);

  if (!embedding) return [];

  const { data, error } = await supabaseAdmin.rpc('match_articles', {
    query_embedding: embedding,
    match_count: 24
  });

  if (error) {
    console.error('Embedding article retrieval failed:', error);
    return [];
  }

  const ids = (data || [])
    .map((r: { article_id?: string }) => r.article_id)
    .filter(Boolean) as string[];

  if (!ids.length) return [];

  const { data: articles, error: articleError } = await activeArticleQuery().in('id', ids);

  if (articleError) throw articleError;

  const byId = new Map((articles || []).map((article) => [article.id, article as ArticleContext]));

  return ids.map((id) => byId.get(id)).filter(Boolean) as ArticleContext[];
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const { query } = await req.json();

    if (!query || typeof query !== 'string') {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

    const related = await retrieveArticles(query);
    const answer = await analyze(query, related);

    const { data: report, error } = await supabaseAdmin
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

    return Response.json({ report, related_articles: related, answer });
  } catch (error) {
    return jsonError(error);
  }
}

async function retrieveArticles(query: string): Promise<ArticleContext[]> {
  const keywordArticles = await fetchKeywordArticles(query);
  const embeddingArticles = await fetchEmbeddingArticles(query);
  const combined = uniqueArticles([...keywordArticles, ...embeddingArticles]);

  if (combined.length) return combined.slice(0, 32);

  return fetchRecentArticles(32);
}

async function analyze(query: string, articles: ArticleContext[]) {
  const openai = getOpenAI();

  if (!articles.length) {
    return {
      answer_text:
        '分析対象の記事がDBにありません。まず記事をアップロードしてください。不要記事を削除済みの場合は、残っている記事が0件です。',
      table: [],
      cards: []
    };
  }

  if (!openai) {
    return {
      answer_text: 'OPENAI_API_KEYが未設定のため、関連候補のみ返します。',
      table: [],
      cards: articles.map((a) => ({
        article_id: a.id,
        headline: a.headline,
        reason: '関連候補'
      }))
    };
  }

  const articleContext = articles.map((a, i) => ({
    no: i + 1,
    article_id: a.id,
    headline: a.headline,
    status: a.status,
    created_at: a.created_at,
    tags: (a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`),
    text: (a.ocr_text || '').slice(0, 3000)
  }));

  const system = [
    'あなたはマーケティングリサーチの上級コンサルタントです。',
    '蓄積されたMJ記事候補を根拠に、生活者トレンド、業界課題、リサーチ課題、手法適性を分析します。',
    '回答は必ずJSONで返します。answer_text, table, cards を必ず含めます。',
    'cardsには根拠記事IDを必ず含めます。',
    '対象手法は N1探索 / ビジュアル投影 / BOT調査 / リフレクション / 定量調査 の5つだけです。',
    'ユーザーの指定カテゴリに該当する記事がない場合は、無理に分析せず「該当記事なし」と明記してください。',
    '記事にない内容を補完しないでください。不確かな点は断定しないでください。',
    '元記事確認が必要な場合はcardsのnoteに入れてください。'
  ].join('\n');

  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify(
          {
            user_query: query,
            articles: articleContext
          },
          null,
          2
        )
      }
    ]
  });

  const raw = completion.choices[0]?.message.content || '{}';

  try {
    const parsed = JSON.parse(raw);

    return {
      answer_text:
        typeof parsed.answer_text === 'string'
          ? parsed.answer_text
          : typeof parsed.summary === 'string'
            ? parsed.summary
            : raw,
      table: Array.isArray(parsed.table) ? parsed.table : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      ...parsed
    };
  } catch {
    return {
      answer_text: raw,
      table: [],
      cards: []
    };
  }
}
