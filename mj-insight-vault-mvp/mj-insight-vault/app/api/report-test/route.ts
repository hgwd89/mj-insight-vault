import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'agent/inventory-smoke-v2';
const MAX_QUERY_CHARS = 12_000;
const REPORT_REQUIREMENTS = [
  '暫定テストレポート。結論、主要テーマ、根拠記事、反証・制約、実務含意、追加調査課題を含める。',
  '記事にないことは断定しない。正式レポートとは扱わない。',
  'report_title、answer_text、見出し、本文、表、箇条書き、注記を含む説明文は日本語で記述する。',
  '固有名詞、製品名、組織名、モデル名、原文引用に必要な語を除き、英語の説明文・英語見出し・英語のまとめを生成しない。',
  '英語の分析メモを途中生成しても最終出力へ残さず、自然な日本語へ翻訳・統合してから返す。'
].join(' ');

type JsonRecord = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function previewOnly() {
  return process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === BRANCH;
}

export async function POST(req: NextRequest) {
  if (!previewOnly()) return new Response('Not Found', { status: 404 });

  try {
    requireAppPassword(req);
    const raw = await req.json().catch(() => ({})) as JsonRecord;
    const query = text(raw.query);
    if (!query) return Response.json({ error: 'query is required' }, { status: 400 });
    if (query.length > MAX_QUERY_CHARS) {
      return Response.json({ error: `query is too long; maximum is ${MAX_QUERY_CHARS} characters` }, { status: 413 });
    }

    const result = await runChatAnalysis({
      query,
      model: text(raw.model) || 'gpt-4o-mini',
      target_scope: 'all',
      output_template: 'auto',
      require_full_corpus: false,
      report_requirements: REPORT_REQUIREMENTS,
      preview_report_test: true
    });

    const report = isRecord(result.report) ? result.report : null;
    const reportId = text(report?.id);
    if (!reportId) {
      return Response.json({
        error: text(result.report_error) || 'provisional report was generated but not saved',
        result
      }, { status: 500 });
    }

    return Response.json({ report, result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
