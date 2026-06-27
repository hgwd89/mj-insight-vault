import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const HIDDEN_BATCH_STATUSES = new Set(['deleted', 'excluded', 'rejected']);

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);

    const { data, error } = await supabaseAdmin
      .from('upload_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    const batches = (data || []).filter((batch) => !HIDDEN_BATCH_STATUSES.has(batch.status));

    return Response.json({ batches });
  } catch (error) {
    return jsonError(error);
  }
}
