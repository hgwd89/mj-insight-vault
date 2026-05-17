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

    const { data, error } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    return Response.json({ reports: (data || []).filter((report) => !isHidden(report)).slice(0, 100) });
  } catch (error) {
    return jsonError(error);
  }
}
