import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function isHidden(report: { answer_json?: unknown }) {
  const value = report.answer_json;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).hidden === true;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

    const { data, error, count } = await supabaseAdmin
      .from('chat_reports')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    const visible = (data || []).filter((report) => !isHidden(report));
    return Response.json({ reports: visible, meta: { limit, offset, returned: visible.length, total_estimate: count || 0 } });
  } catch (error) {
    return jsonError(error);
  }
}
