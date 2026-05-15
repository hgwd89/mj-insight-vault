import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText, getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ArticleContext = { id: string; headline: string | null; ocr_text: string | null; article_tags?: { tag_type: string; tag_name: string }[] };

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const { query } = await req.json();
    if (!query || typeof query !== 'string') return Response.json({ error: 'query is required' }, { status: 400 });

    const related = await retrieveArticles(query);
    const answer = await analyze(query, related);

    const { data: report, error } = await supabaseAdmin.from('chat_reports').insert({
      user_query: query,
      answer_text: answer.answer_text,
      answer_json: answer,
      related_article_ids: related.map((a) => a.id)
    }).select('*').single();
    if (error) throw error;

    return Response.json({ report, related_articles: related, answer });
  } catch (error) {
    return jsonError(error);
  }
}

async function retrieveArticles(query: string): Promise<ArticleContext[]> {
  const embedding = await embedText(query);
  if (embedding) {
    const { data } = await supabaseAdmin.rpc('match_articles', { query_embedding: embedding, match_count: 16 });
    const ids = (data || []).map((r: { article_id: string }) => r.article_id);
    if (ids.length) {
      const { data: articles } = await supabaseAdmin.from('articles').select('id, headline, ocr_text, article_tags(tag_type, tag_name)').in('id', ids);
      return (articles || []) as ArticleContext[];
    }
  }
  const keywords = query.replace(/[、。・「」]/g, ' ').split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
  const first = keywords[0] || query.slice(0, 10);
  const { data } = await supabaseAdmin
    .from('articles')
    .select('id, headline, ocr_text, article_tags(tag_type, tag_name)')
    .or(`headline.ilike.%${first}%,ocr_text.ilike.%${first}%`)
    .order('created_at', { ascending: false })
    .limit(16);
  return (data || []) as ArticleContext[];
}

async function analyze(query: string, articles: ArticleContext[]) {
  const openai = getOpenAI();
  if (!openai) {
    return {
      answer_text: 'OPENAI_API_KEYが未設定のため、関連候補のみ返します。',
      table: [],
      cards: articles.map((a) => ({ article_id: a.id, headline: a.headline, reason: '関連候補' }))
    };
  }

  const articleContext = articles.map((a, i) => ({
    no: i + 1,
    article_id: a.id,
    headline: a.headline,
    tags: (a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`),
    text: (a.ocr_text || '').slice(0, 1800)
  }));

  const system = [
    'あなたはマーケティングリサーチの上級コンサルタントです。',
    '蓄積されたMJ記事候補を根拠に、生活者トレンド、業界課題、リサーチ課題、手法適性を分析します。',
    '回答は必ずJSONで返します。根拠記事IDを必ず含めます。',
    '対象手法は N1探索 / ビジュアル投影 / BOT調査 / リフレクション / 定量調査 の5つだけです。',
    '不確かな点は断定しないでください。元記事確認が必要な場合はカードに note を入れてください。'
  ].join('\n');

  const completion = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ user_query: query, articles: articleContext }, null, 2) }
    ]
  });

  const raw = completion.choices[0]?.message.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { answer_text: raw, table: [], cards: [] };
  }
}
