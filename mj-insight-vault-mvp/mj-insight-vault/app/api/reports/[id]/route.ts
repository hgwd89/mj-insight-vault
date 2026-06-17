import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type ArticleRow = { id: string; [key: string]: unknown };

function mergeAnswerJson(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};

  return { ...base, ...patch };
}

function articleIdsFromAnswer(answer: unknown) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [] as string[];
  const a = answer as Record<string, unknown>;
  const ids = new Set<string>();
  for (const key of ['selected_article_ids', 'evidence_article_ids']) {
    const value = a[key];
    if (Array.isArray(value)) value.forEach((id) => { if (typeof id === 'string') ids.add(id); });
  }
  for (const key of ['evidence_matrix', 'article_lookup']) {
    const value = a[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const id = record.article_id || record.id;
        if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const url = new URL(req.url);
    const includeOcr = url.searchParams.get('include_ocr') === '1';
    const limit = Math.max(0, Math.min(200, Number(url.searchParams.get('related_limit') || 80)));

    const { data: report, error } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!report) return Response.json({ error: 'report not found' }, { status: 404 });

    let related_articles: ArticleRow[] = [];
    const reportRecord = report as Record<string, unknown>;
    const rootIds = Array.isArray(reportRecord.related_article_ids) ? reportRecord.related_article_ids.filter((value): value is string => typeof value === 'string') : [];
    const priorityIds = articleIdsFromAnswer(reportRecord.answer_json);
    const orderedIds = Array.from(new Set([...priorityIds, ...rootIds])).slice(0, limit);

    if (orderedIds.length > 0) {
      const columns = includeOcr
        ? 'id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)'
        : 'id, headline, article_date, status, created_at, article_tags(tag_type, tag_name)';
      const { data: articles, error: articleError } = await supabaseAdmin
        .from('articles')
        .select(columns)
        .in('id', orderedIds);

      if (articleError) throw articleError;

      const rows = (articles || []) as ArticleRow[];
      const byId = new Map(rows.map((article) => [article.id, article]));
      related_articles = orderedIds.map((articleId: string) => byId.get(articleId)).filter((article): article is ArticleRow => Boolean(article));
    }

    return Response.json({
      report,
      related_articles,
      related_articles_meta: {
        total_related_ids: rootIds.length,
        returned: related_articles.length,
        include_ocr: includeOcr,
        limit
      }
    });
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
    if (!currentReport) return Response.json({ error: 'report not found' }, { status: 404 });

    const currentRecord = currentReport as Record<string, unknown>;
    const metadataPatch: Record<string, unknown> = {};

    if ('report_title' in body) metadataPatch.report_title = String(body.report_title || '').trim();
    if ('pinned' in body) {
      metadataPatch.pinned = Boolean(body.pinned);
      metadataPatch.pinned_at = body.pinned ? new Date().toISOString() : null;
    }
    if ('hidden' in body) {
      metadataPatch.hidden = Boolean(body.hidden);
      metadataPatch.hidden_at = body.hidden ? new Date().toISOString() : null;
    }

    const answerJson = mergeAnswerJson(currentRecord.answer_json, metadataPatch);

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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;

    const { data: currentReport, error: currentError } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .eq('id', id)
      .single();

    if (currentError) throw currentError;
    if (!currentReport) return Response.json({ error: 'report not found' }, { status: 404 });
    const currentRecord = currentReport as Record<string, unknown>;

    const answerJson = mergeAnswerJson(currentRecord.answer_json, {
      hidden: true,
      hidden_at: new Date().toISOString()
    });

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
