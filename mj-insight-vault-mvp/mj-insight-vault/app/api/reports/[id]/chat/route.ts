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

type LinkedArticle = ReturnType<typeof addArticleLinks>;

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

function isRelatedArticle(article: RelatedArticle | undefined): article is RelatedArticle {
  return Boolean(article);
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

    const articleIds = Array.isArray(report.related_article_ids) ? report.related_article_ids : [];
    let articles: LinkedArticle[] = [];

    if (articleIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('articles')
        .select('id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)')
        .in('id', articleIds);

      if (error) throw error;

      const byId = new Map(((data || []) as RelatedArticle[]).map((article) => [article.id, article]));
      articles = articleIds
        .map((articleId: string) => byId.get(articleId))
        .filter(isRelatedArticle)
        .map((article: RelatedArticle) => addArticleLinks(article));
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
      'Return JSON only.',
      'You are a senior marketing research consultant continuing analysis of a saved MJ report.',
      'Use the original report and related articles as evidence. Do not invent article facts.',
      'Cite evidence using clickable article links when possible, e.g. [headline｜date](/articles/id).',
      'If evidence is weak, state that clearly and turn it into a research question.',
      'Required keys: answer_text, suggested_next_angles, referenced_articles, model_used.'
    ].join('\n');

    const articlePayload = articles.map((article, index) => ({
      no: index + 1,
      article_id: article.id,
      headline: article.headline,
      article_date: article.article_date || '日付不明',
      article_url: article.article_url,
      article_link: article.article_link,
      tags: article.article_tags || [],
      text: (article.ocr_text || '').slice(0, 2600)
    }));

    const messages = [
      { role: 'system' as const, content: system },
      ...conversation,
      {
        role: 'user' as const,
        content: JSON.stringify({
          saved_report: {
            report_id: report.id,
            original_user_query: report.user_query,
            answer_text: getReportAnswerText(report as Record<string, unknown>),
            answer_json: report.answer_json || null
          },
          followup_query: query,
          related_articles: articlePayload
        }, null, 2)
      }
    ];

    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages
    });

    const raw = completion.choices[0]?.message.content || '{}';
    const answer = JSON.parse(raw) as Record<string, unknown>;
    answer.model_used = model;

    const followup = await saveFollowupReport({
      parentReportId: report.id,
      originalQuery: report.user_query,
      followupQuery: query,
      answer,
      articleIds: articles.map((article) => article.id)
    });

    return Response.json({ answer, followup_report: followup });
  } catch (error) {
    return jsonError(error);
  }
}
