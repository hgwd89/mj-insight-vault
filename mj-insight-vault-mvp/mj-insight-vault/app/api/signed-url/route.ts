import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const path = new URL(req.url).searchParams.get('path');
    if (!path) return Response.json({ error: 'path is required' }, { status: 400 });
    const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).createSignedUrl(path, 60 * 30);
    if (error) throw error;
    return Response.json({ url: data.signedUrl });
  } catch (error) {
    return jsonError(error);
  }
}
