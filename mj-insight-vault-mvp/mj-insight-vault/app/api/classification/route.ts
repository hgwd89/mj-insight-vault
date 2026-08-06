import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getArticleClassificationStatus } from '@/lib/articleClassificationWorker';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getArticleClassificationStatus());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;
    const model = String(body.model || process.env.OPENAI_CLASSIFICATION_MODEL || 'gpt-4o-mini').trim();
    const { data, error } = await supabaseAdmin.rpc('enqueue_article_classification_v2', {
      p_force: force,
      p_model: model
    });
    if (error) throw error;
    return Response.json({ queued: data, ...(await getArticleClassificationStatus()) }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
