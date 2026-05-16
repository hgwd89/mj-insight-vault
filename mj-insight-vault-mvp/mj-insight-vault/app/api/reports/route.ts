import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);

    const { data, error } = await supabaseAdmin
      .from('chat_reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return Response.json({ reports: data || [] });
  } catch (error) {
    return jsonError(error);
  }
}
