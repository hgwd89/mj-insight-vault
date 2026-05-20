import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type RelatedArticle = {
  id: string;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
  status: string | null;
  created_at: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};

const DEFAULT_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];

function articleUrl(articleId: string) {
  return `/articles/${articleId}`;
}

function articleLabel(article: RelatedArticle) {
  return `${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}`;
}

function articleLink(article: RelatedArticle) {
  return `[${articleLabel(article)}](${articleUrl(article.id)})`;
}

function addArticleLinks(article: RelatedArticle) {
  return {
    ...article,
    article_url: articleUrl(article.id),
    article_link: articleLink(article)
  };
}

function getSelectableModels() {
  const fromEnv = (process.env.OPENAI_CHAT_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return Array.from(new Set([TEXT_MODEL, ...fromEnv, ...DEFAULT_MODELS].filter(Boolean)));
}

function normalizeModel(value: unknown) {
  const models = getSelectableModels();
  return typeof value === 'string' && models.includes(value) ? value : TEXT_MODEL;
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
      return { role, content: content.slice(0, 8000) };
    })
    .filter(Boolean)
    .slice(-10) as ConversationTurn[];
}

function getReportAnswerText(report: Record<string, unknown>) {
  if (typeof report.answer_text === 'string') return report.answer_text;

  const answerJson = report.answer_json;
  if (answerJson && typeof answerJson === 'object') {
    const record = answerJson as Record<string, unknown>;
    if (typeof record.answer_text === 'string') return record.answer_text;
    if (typeof record.summary === 'string') return record.summary;
  }

  return '';
}

async function saveFollowupReport(args: {
  parentReportId: string;
  originalQuery: string;
  followupQuery: string;
  answer: Record<string, unknown>;
  articleIds: string[];
}) {
  const answerText = typeof args.answer.answer_text === 'string' ? args.answer.answer_text : JSON.stringify(args.answer);

  const { data, error } = await supabaseAdmin
    .from('chat_reports')
    .insert({
      user_query: `レポート深掘り: ${args.followupQuery}`,
      answer_text: answerText,
      answer_json: {
        ...args.answer,
        parent_report_id: args.parentReportId,
        parent_user_query: args.originalQuery,
        followup_query: args.followupQuery,
        report_chat: true
      },
      related_article_ids: args.articleIds
    })
    .select('*')
    .single();

  if (error) {
    console.error('followup chat_reports insert failed:', error);
    return null;
  }

  return data;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const body = await req.json();
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const model = normalizeModel(body.model);
    const conversation = normalizeConversation(body.conversation);

    if (!query) {
      return Response.json({ error: 'query is required' }, { status: 400 });
    }

    const { data: report, error: reportError } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .eq('id', id)
      .single();

    if (reportError) throw reportError;

    const articleIds: string[] = Array.isArray(report.related_article_ids)
      ? report.related_article_ids.map((articleId: unknown) => String(articleId || '')).filter(Boolean)
      : [];
    let articles: ReturnType<typeof addArticleLinks>[] = [];

    if (articleIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('articles')
        .select('id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)')
        .in('id', articleIds);

      if (error) throw error;

      const byId = new Map(((data || []) as RelatedArticle[]).map((article) => [article.id, article]));
      articles = articleIds
        .map((articleId: string) => byId.get(articleId))
        .filter((article): article is RelatedArticle => Boolean(article))
        .map((article) => addArticleLinks(article));
    }

    const openai = getOpenAI();

    if (!openai) {
      return Response.json({
        answer: {
          answer_text: 'OPENAI_API_KEYが未設定のため、レポートへの追加質問に回答できません。',
          model_used: model
        },
        followup_report: null
      });
    }

    const system = [
      'あなたはMJ記事エージェントです。',
      '既存の分析レポートと根拠記事を踏まえ、ユーザーの追加質問に対話的に答えます。',
      '役割は、分析観点の追加、WHYの深掘り、仮説の再整理、根拠記事への立ち戻り、リサーチ課題化、提案書化です。',
      '回答は必ずJSONで返し、answer_text, suggested_next_angles, referenced_articles を含めてください。',
      '記事にない内容は断定せず、仮説と明記してください。',
      '根拠を示す場合、UUIDだけでなく article_link を使い、answer_text では [記事タイトル｜日付](/articles/id) 形式で書いてください。',
      'referenced_articles には article_id, headline, article_date, article_url, article_link, reason を入れてください。',
      '日付が不明な記事は日付不明と明記してください。',
      '日本語で、実務で使える粒度にしてください。'
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            instruction: '以下は既存レポートと根拠記事です。この内容を会話の前提にしてください。根拠提示では article_link を優先してください。',
            report: {
              id: report.id,
              original_query: report.user_query,
              answer_text: getReportAnswerText(report),
              answer_json: report.answer_json,
              created_at: report.created_at
            },
            related_articles: articles
          }, null, 2)
        },
        ...conversation,
        { role: 'user', content: query }
      ]
    });

    const raw = completion.choices[0]?.message.content || '{}';

    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(raw);
    } catch {
      answer = { answer_text: raw, suggested_next_angles: [], referenced_articles: [] };
    }

    if (typeof answer.answer_text !== 'string') {
      answer.answer_text = raw;
    }

    answer.model_used = model;
    answer.parent_report_id = id;

    const followupReport = await saveFollowupReport({
      parentReportId: id,
      originalQuery: report.user_query,
      followupQuery: query,
      answer,
      articleIds
    });

    return Response.json({ answer, related_articles: articles, followup_report: followupReport });
  } catch (error) {
    return jsonError(error);
  }
}
