import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type JobPayload = Record<string, unknown>;

const ALL_SCOPE_WORDS = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/i;
const PIPELINE_VERSION = 'report_pipeline_v3';
const MAX_QUERY_CHARS = 12_000;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function stripReportInstruction(query: string) {
  return query.split('\n\n【レポート要件】')[0].trim() || query.trim();
}

function normalizeChatJobRequest(rawBody: JobPayload) {
  const query = text(rawBody.query);
  const targetScope = text(rawBody.target_scope);
  const body = { ...rawBody, pipeline_version: PIPELINE_VERSION };

  if (targetScope !== 'all' || ALL_SCOPE_WORDS.test(query)) {
    return { body, query };
  }

  const normalizedQuery = `全記事を対象に、全データを広域スキャンしたうえで分析してください。\n${query}`;
  return {
    body: {
      ...body,
      query: normalizedQuery
    },
    query: normalizedQuery
  };
}

async function latestActiveJob() {
  const { data, error } = await supabaseAdmin
    .from('chat_jobs')
    .select('*')
    .in('status', ['queued', 'running'])
    .eq('request_json->>pipeline_version', PIPELINE_VERSION)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const url = new URL(req.url);
    if (url.searchParams.get('active') !== '1') {
      return Response.json({ error: 'active=1 is required' }, { status: 400 });
    }
    return Response.json({ job: await latestActiveJob() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const rawBody = await req.json() as JobPayload;
    const { body, query } = normalizeChatJobRequest(rawBody);
    if (!query) return Response.json({ error: 'query is required' }, { status: 400 });
    if (query.length > MAX_QUERY_CHARS) {
      return Response.json({ error: `query is too long; maximum is ${MAX_QUERY_CHARS} characters` }, { status: 413 });
    }

    const active = await latestActiveJob();
    if (active) {
      return Response.json({
        error: '未完了のレポートジョブがあります。完了または停止を確認してから新しいジョブを開始してください。',
        job: active,
        active_job_exists: true
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('chat_jobs').insert({
      status: 'queued',
      progress: 3,
      stage: 'ジョブを作成しました',
      user_query: stripReportInstruction(query),
      request_json: body,
      result_json: null,
      report_id: null,
      error_message: null,
      started_at: null,
      finished_at: null,
      heartbeat_at: now,
      next_retry_at: null
    }).select('*').single();

    if (error) throw error;
    return Response.json({ job: data });
  } catch (error) {
    return jsonError(error);
  }
}
