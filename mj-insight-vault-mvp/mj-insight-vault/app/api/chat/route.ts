import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText, getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

type AnalysisMode = 'standard' | 'deep' | 'fast' | 'retrieval_only';

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

const HIDDEN_STATUSES = new Set(['deleted', 'excluded', 'rejected']);

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

function normalizeAnalysisMode(value: unknown): AnalysisMode {
  if (value === 'deep' || value === 'fast' || value === 'retrieval_only') return value;
  return 'standard';
}

function getAnalysisModel(mode: AnalysisMode) {
  if (mode === 'deep') {
    return process.env.OPENAI_DEEP_ANALYSIS_MODEL || process.env.OPENAI_TEXT_MODEL || TEXT_MODEL;
  }

  if (mode === 'fast') {
    return process.env.OPENAI_FAST_ANALYSIS_MODEL || process.env.OPENAI_TEXT_MODEL || TEXT_MODEL;
  }

  return process.env.OPENAI_TEXT_MODEL || TEXT_MODEL;
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
    .map((word) =>
      word.replace(
        /(だけ|関連|記事|分析|して|出して|整理|業界|今月分|今月|リサーチ|課題|テーマ|向いている|回すべき|ください)/g,
        ''
      )
    )
    .filter((word) => word.length >= 2)
    .slice(0, 8)
    .forEach((word) => keywords.add(word));

  return Array.from(keywords).map(escapeLike).filter(Boolean).slice(0, 12);
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

  const clauses = keywords.flatMap((keyword) => [
    `headline.ilike.%${keyword}%`,
    `ocr_text.ilike.%${keyword}%`
  ]);

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

  const ids = (data || [])
    .map((r: { article_id?: string }) => r.article_id)
    .filter(Boolean) as string[];

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

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const body = await req.json();
    const { query } = body;
    const analysisMode = normalizeAnalysisMode(body.analysis_mode);

    if (!query || typeof query !== 'string') {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

    const related = await retrieveArticles(query);
    const answer = await analyze(query, related, analysisMode);

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

    return Response.json({
      report,
      report_error,
      related_articles: related,
      answer
    });
  } catch (error) {
    return jsonError(error);
  }
}

async function retrieveArticles(query: string): Promise<ArticleContext[]> {
  const keywordArticles = await fetchKeywordArticles(query);
  const embeddingArticles = await fetchEmbeddingArticles(query);
  const recentArticles = await fetchRecentArticles(40);

  return uniqueArticles([...keywordArticles, ...embeddingArticles, ...recentArticles]).slice(0, 40);
}

async function analyze(query: string, articles: ArticleContext[], analysisMode: AnalysisMode) {
  const openai = getOpenAI();
  const model = getAnalysisModel(analysisMode);

  if (!articles.length) {
    return {
      answer_text: '分析対象の記事がDBにありません。記事一覧に有効記事があるか、status が deleted/excluded/rejected になっていないか確認してください。',
      table: [],
      cards: [],
      analysis_mode: analysisMode,
      model_used: analysisMode === 'retrieval_only' ? 'none' : model,
      related_article_count: 0
    };
  }

  const fallbackCards = articles.slice(0, 12).map((a) => ({
    article_id: a.id,
    headline: a.headline,
    reason: '分析対象候補'
  }));

  if (analysisMode === 'retrieval_only') {
    return {
      answer_text: `記事候補のみ表示します。関連候補${articles.length}件を取得しました。`,
      table: [],
      cards: fallbackCards,
      analysis_mode: analysisMode,
      model_used: 'none',
      related_article_count: articles.length
    };
  }

  if (!openai) {
    return {
      answer_text: `OPENAI_API_KEYが未設定のため、関連候補${articles.length}件のみ返します。`,
      table: [],
      cards: fallbackCards,
      analysis_mode: analysisMode,
      model_used: model,
      related_article_count: articles.length
    };
  }

  const articleContext = articles.map((a, i) => ({
    no: i + 1,
    article_id: a.id,
    headline: a.headline,
    status: a.status || 'active',
    created_at: a.created_at,
    tags: (a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`),
    text: (a.ocr_text || '').slice(0, analysisMode === 'deep' ? 4500 : 2500)
  }));

  const depthInstruction = analysisMode === 'deep'
    ? 'WHYを深く掘り、生活者変化、背後欲求、調査仮説、提案示唆まで厚めに出してください。'
    : analysisMode === 'fast'
      ? '短く、実務上使える要点に絞ってください。'
      : '根拠と示唆のバランスを取り、実務で使える粒度で出してください。';

  const system = [
    'あなたはマーケティングリサーチの上級コンサルタントです。',
    '蓄積されたMJ記事候補を根拠に、生活者トレンド、業界課題、リサーチ課題、手法適性を分析します。',
    depthInstruction,
    '回答は必ずJSONで返します。',
    '必ず answer_text, table, cards を含めてください。',
    'cardsには根拠記事IDを必ず含めてください。',
    '対象手法は N1探索 / ビジュアル投影 / BOT調査 / リフレクション / 定量調査 の5つです。',
    'ユーザーの指定カテゴリに完全一致する記事が少ない場合は、近い記事を使った上で「該当記事は少ない」と明記してください。',
    '記事にない内容を断定しないでください。',
    '不確かな点は「仮説」と明記してください。',
    '回答は日本語で、実務で使える粒度にしてください。'
  ].join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: analysisMode === 'deep' ? 0.25 : 0.15,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify(
            {
              user_query: query,
              analysis_mode: analysisMode,
              article_count: articleContext.length,
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
        cards: Array.isArray(parsed.cards) ? parsed.cards : fallbackCards,
        ...parsed,
        analysis_mode: analysisMode,
        model_used: model,
        related_article_count: articles.length
      };
    } catch {
      return {
        answer_text: raw,
        table: [],
        cards: fallbackCards,
        analysis_mode: analysisMode,
        model_used: model,
        related_article_count: articles.length
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    console.error('OpenAI analysis failed:', error);
    return {
      answer_text: `OpenAI分析でエラーが出ました。関連候補${articles.length}件は取得できています。エラー: ${message}`,
      table: [],
      cards: fallbackCards,
      analysis_mode: analysisMode,
      model_used: model,
      related_article_count: articles.length
    };
  }
}
