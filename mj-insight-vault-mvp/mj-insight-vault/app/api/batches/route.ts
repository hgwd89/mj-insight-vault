import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const { data, error } = await supabaseAdmin
      .from('upload_batches')
      .select('*, source_images(count), articles(count)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return Response.json({ batches: data });
  } catch (error) {
    return jsonError(error);
  }
}
