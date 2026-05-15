import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const { data, error } = await supabaseAdmin.from('tag_master').select('*').order('tag_type').order('tag_name');
    if (error) throw error;
    return Response.json({ tags: data });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json();
    if (!body.tag_type || !body.tag_name) return Response.json({ error: 'tag_type and tag_name are required' }, { status: 400 });
    const { data, error } = await supabaseAdmin
      .from('tag_master')
      .insert({ tag_type: body.tag_type, tag_name: body.tag_name, description: body.description || null })
      .select('*')
      .single();
    if (error) throw error;
    return Response.json({ tag: data });
  } catch (error) {
    return jsonError(error);
  }
}
