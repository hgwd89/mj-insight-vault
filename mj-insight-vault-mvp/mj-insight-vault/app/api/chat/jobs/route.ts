import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type JobPayload = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function stripReportInstruction(query: string) {
  return query.split('\n\n【レポート要件】')[0].trim() || query.trim();
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json() as JobPayload;
    const query = text(body.query);
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
