import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const { data, error } = await supabaseAdmin
      .from('corpus_scan_execution_priority_view')
      .select('*')
      .order('priority_score', { ascending: false })
      .limit(50);
    if (error) throw error;
    return Response.json({ runs: data || [] });
  } catch (error) {
    return jsonError(error);
  }
}
