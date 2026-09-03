import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function previewFromArticleText(value: unknown) {
  const text = clean(value, 20000);
  if (!text) return '';
  const bodyMarker = '【本文再構成】';
  const start = text.indexOf(bodyMarker);
  if (start >= 0) {
    const after = text.slice(start + bodyMarker.length).trim();
    const next = after.search(/\n【[^】]+】/);
    const body = (next >= 0 ? after.slice(0, next) : after).trim();
    if (body) return body.slice(0, 360);
  }
  return text.replace(/【[^】]+】/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360);
}

async function fetchAllArticles(jwt: string) {
  const rows: Array<Record<string, unknown>> = [];
  const pageSize = 500;
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const response = await neonDataFetch(
      `vault_articles?article_sequence=gt.0&select=id,source_file_id,article_sequence,title,ocr_text_raw,ocr_text_verified,verification_status,confidence,created_at,updated_at&order=updated_at.desc&limit=${pageSize}&offset=${offset}`,
      jwt,
      { method: 'GET' }
    );
    const json = await parseUpstreamJson(response, '記事一覧を取得できませんでした。');
    const page = Array.isArray(json) ? json as Array<Record<string, unknown>> : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const query = clean(req.nextUrl.searchParams.get('q'), 500).toLowerCase();

    const articles = await fetchAllArticles(jwt);
    const sourceIds = [...new Set(articles.map((row) => clean(row.source_file_id, 100)).filter(Boolean))];
    const sourceMap = new Map<string, Record<string, unknown>>();

    for (let i = 0; i < sourceIds.length; i += 200) {
      const ids = sourceIds.slice(i, i + 200);
      if (!ids.length) continue;
      const response = await neonDataFetch(
        `vault_source_files?id=in.(${ids.map(encodeURIComponent).join(',')})&source_status=neq.e2e_test&select=id,file_name,article_date,memo,source_status,ocr_status,created_at`,
        jwt,
        { method: 'GET' }
      );
      const json = await parseUpstreamJson(response, '記事の原本情報を取得できませんでした。');
      for (const row of Array.isArray(json) ? json as Array<Record<string, unknown>> : []) {
        sourceMap.set(clean(row.id, 100), row);
      }
    }

    const rows = articles
      .map((article) => {
        const source = sourceMap.get(clean(article.source_file_id, 100));
        if (!source) return null;
        const fullText = clean(article.ocr_text_verified, 100000) || clean(article.ocr_text_raw, 100000);
        return {
          id: article.id,
          source_file_id: article.source_file_id,
          article_sequence: article.article_sequence,
          title: clean(article.title, 1000) || '無題の記事',
          preview: previewFromArticleText(fullText),
          article_date: clean(source.article_date, 32) || null,
          source_file_name: clean(source.file_name, 500),
          verification_status: article.verification_status,
          confidence: article.confidence,
          updated_at: article.updated_at,
          _search: `${clean(article.title, 2000)}\n${fullText}\n${clean(source.file_name, 500)}`.toLowerCase()
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .filter((row) => !query || row._search.includes(query))
      .sort((a, b) => {
        const dateCmp = String(b.article_date || '').localeCompare(String(a.article_date || ''));
        if (dateCmp) return dateCmp;
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      })
      .map(({ _search, ...row }) => row);

    return Response.json({ ok: true, query, count: rows.length, rows });
  } catch (error) {
    return jsonError(error);
  }
}
