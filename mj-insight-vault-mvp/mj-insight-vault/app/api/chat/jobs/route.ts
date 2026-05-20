import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type JobPayload = Record<string, unknown>;

const ALL_SCOPE_WORDS = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/i;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function stripReportInstruction(query: string) {
  return query.split('\n\n【レポート要件】')[0].trim() || query.trim();
}

function normalizeChatJobRequest(body: JobPayload) {
  const query = text(body.query);
  const targetScope = text(body.target_scope);

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

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const rawBody = await req.json() as JobPayload;
    const { body, query } = normalizeChatJobRequest(rawBody);
    if (!query) return Response.json({ error: 'query is required' }, { status: 400 });

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
      heartbeat_at: now
    }).select('*').single();

    if (error) throw error;
    return Response.json({ job: data });
  } catch (error) {
    return jsonError(error);
  }
}
