import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { requireNeonJwt } from '@/lib/neonCloud';
import { getReport, listReportArticles, patchReport } from '@/lib/neonReportStore';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await params;
    const report = await getReport(jwt, id);
    if (!report) return Response.json({ error: 'report not found' }, { status: 404 });

    const url = new URL(req.url);
    const includeOcr = url.searchParams.get('include_ocr') === '1';
    const limit = Math.max(0, Math.min(200, Number(url.searchParams.get('related_limit') || 80)));
    const allIds = Array.isArray(report.related_article_ids) ? report.related_article_ids.map(text).filter(Boolean) : [];
    const ids = allIds.slice(0, limit);
    const rows = await listReportArticles(jwt, ids, includeOcr);
    const related_articles = rows.map((row) => ({
      ...row,
      headline: text(row.title) || '無題',
      article_date: text(row.created_at),
      ocr_text: includeOcr ? text(row.ocr_text_verified || row.ocr_text_raw) : undefined,
      status: text(row.verification_status)
    }));

    return Response.json({
      report,
      related_articles,
      related_articles_meta: {
        total_related_ids: allIds.length,
        returned: related_articles.length,
        include_ocr: includeOcr,
        limit,
        evidence_source: 'vault_articles',
        formal_corpus_only: false
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await params;
    const body = await req.json() as Record<string, unknown>;
    const current = await getReport(jwt, id);
    if (!current) return Response.json({ error: 'report not found' }, { status: 404 });
    const answer = isRecord(current.answer_json) ? { ...current.answer_json } : {};
    const patch: Record<string, unknown> = {};

    if ('report_title' in body) answer.report_title = text(body.report_title);
    if ('pinned' in body) {
      patch.pinned = Boolean(body.pinned);
      answer.pinned = Boolean(body.pinned);
      answer.pinned_at = body.pinned ? new Date().toISOString() : null;
    }
    if ('hidden' in body) {
      patch.hidden = Boolean(body.hidden);
      answer.hidden = Boolean(body.hidden);
      answer.hidden_at = body.hidden ? new Date().toISOString() : null;
    }
    patch.answer_json = answer;
    const report = await patchReport(jwt, id, patch);
    if (!report) return Response.json({ error: 'report not found' }, { status: 404 });
    return Response.json({ report });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await params;
    const current = await getReport(jwt, id);
    if (!current) return Response.json({ error: 'report not found' }, { status: 404 });
    const answer = isRecord(current.answer_json) ? { ...current.answer_json } : {};
    answer.hidden = true;
    answer.hidden_at = new Date().toISOString();
    const report = await patchReport(jwt, id, { hidden: true, answer_json: answer });
    return Response.json({ report });
  } catch (error) {
    return jsonError(error);
  }
}
