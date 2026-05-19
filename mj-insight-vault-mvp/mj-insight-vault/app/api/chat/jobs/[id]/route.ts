import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

async function getParams(ctx: RouteContext) {
  return 'then' in ctx.params ? await ctx.params : ctx.params;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    requireAppPassword(req);
    const { id } = await getParams(ctx);
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });

    const { data, error } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', id).single();
    if (error) throw error;
    return Response.json({ job: data });
  } catch (error) {
    return jsonError(error);
  }
}
