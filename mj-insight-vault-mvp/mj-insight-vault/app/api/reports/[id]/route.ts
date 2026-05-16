import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function mergeAnswerJson(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};

  return { ...base, ...patch };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;

    const { data: report, error } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    let related_articles: unknown[] = [];
    const articleIds = Array.isArray(report.related_article_ids) ? report.related_article_ids : [];

    if (articleIds.length > 0) {
      const { data: articles, error: articleError } = await supabaseAdmin
        .from('articles')
        .select('id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)')
        .in('id', articleIds);

      if (articleError) throw articleError;

      const byId = new Map((articles || []).map((article) => [article.id, article]));
      related_articles = articleIds.map((articleId: string) => byId.get(articleId)).filter(Boolean);
    }

    return Response.json({ report, related_articles });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const body = await req.json();

    const { data: currentReport, error: currentError } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .eq('id', id)
      .single();

    if (currentError) throw currentError;

    const metadataPatch: Record<string, unknown> = {};

    if ('report_title' in body) {
      metadataPatch.report_title = String(body.report_title || '').trim();
    }

    if ('pinned' in body) {
      metadataPatch.pinned = Boolean(body.pinned);
      metadataPatch.pinned_at = body.pinned ? new Date().toISOString() : null;
    }

    const answerJson = mergeAnswerJson(currentReport.answer_json, metadataPatch);

    const { data: report, error } = await supabaseAdmin
      .from('chat_reports')
      .update({ answer_json: answerJson })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    return Response.json({ report });
  } catch (error) {
    return jsonError(error);
  }
}
