import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function mergeAnswerJson(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};

  return { ...base, ...patch };
}

function usesFormalCorpusEvidence(report: Record<string, unknown>) {
  if (report.is_formal_report === true) return true;

  const answerJson = report.answer_json;
  if (!answerJson || typeof answerJson !== 'object' || Array.isArray(answerJson)) return false;

  const metadata = answerJson as Record<string, unknown>;
  return metadata.formal_corpus_only === true
    && metadata.evidence_source === 'formal_corpus_articles_v1';
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

    let related_articles: unknown[] = [];
    const allArticleIds = Array.isArray(report.related_article_ids) ? report.related_article_ids : [];
    const articleIds = allArticleIds.slice(0, limit);
    const formalCorpusOnly = usesFormalCorpusEvidence(report as Record<string, unknown>);

    if (articleIds.length > 0) {
      // Formal reports and their saved follow-ups must resolve evidence from the same
      // verified corpus contract. Reading mutable raw `articles` here can make a saved
      // formal proof or a downstream follow-up point at evidence that no longer belongs
      // to the verified corpus.
      const result = formalCorpusOnly
        ? includeOcr
          ? await supabaseAdmin
            .from('formal_corpus_articles_v1')
            .select('id, headline, article_date, ocr_text, status, created_at')
            .in('id', articleIds)
          : await supabaseAdmin
            .from('formal_corpus_articles_v1')
            .select('id, headline, article_date, status, created_at')
            .in('id', articleIds)
        : includeOcr
          ? await supabaseAdmin
            .from('articles')
            .select('id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)')
            .in('id', articleIds)
          : await supabaseAdmin
            .from('articles')
            .select('id, headline, article_date, status, created_at, article_tags(tag_type, tag_name)')
            .in('id', articleIds);

      if (result.error) throw result.error;

      const rows = (result.data || []) as Array<{ id: string }>;
      const byId = new Map(rows.map((article) => [article.id, article]));
      related_articles = articleIds.map((articleId: string) => byId.get(articleId)).filter(Boolean);

      if (formalCorpusOnly && related_articles.length !== articleIds.length) {
        const resolvedIds = new Set(rows.map((article) => String(article.id)));
        const missingIds = articleIds.filter((articleId: string) => !resolvedIds.has(articleId));
        throw new Error(`formal-corpus report evidence is no longer present in formal_corpus_articles_v1: ${missingIds.join(',')}`);
      }
    }

    return Response.json({
      report: sanitizeReportForDisplay(report),
      related_articles,
      related_articles_meta: {
        total_related_ids: allArticleIds.length,
        returned: related_articles.length,
        include_ocr: includeOcr,
        limit,
        evidence_source: formalCorpusOnly ? 'formal_corpus_articles_v1' : 'articles',
        formal_corpus_only: formalCorpusOnly
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

    const answerJson = mergeAnswerJson(currentReport.answer_json, metadataPatch);

    const { data: report, error } = await supabaseAdmin
      .from('chat_reports')
      .update({ answer_json: answerJson })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    return Response.json({ report: sanitizeReportForDisplay(report) });
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

    const answerJson = mergeAnswerJson(currentReport.answer_json, {
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

    return Response.json({ report: sanitizeReportForDisplay(report) });
  } catch (error) {
    return jsonError(error);
  }
}
