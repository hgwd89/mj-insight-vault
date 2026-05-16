import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type ArticleTagInput = {
  tag_type?: string;
  tag_name?: string;
};

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const tags: { tag_type: string; tag_name: string }[] = [];

  for (const item of value as ArticleTagInput[]) {
    const tagType = String(item?.tag_type || '').trim();
    const tagName = String(item?.tag_name || '').trim();

    if (!tagType || !tagName) continue;

    const key = `${tagType}::${tagName}`;
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push({ tag_type: tagType, tag_name: tagName });
  }

  return tags.slice(0, 50);
}

function mergeManualAnalysis(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};

  return { ...base, ...patch };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;

    const { data: article, error } = await supabaseAdmin
      .from('articles')
      .select('*, article_tags(*), source_images(id, storage_path, file_name, mime_type)')
      .eq('id', id)
      .single();

    if (error) throw error;

    return Response.json({ article });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const body = await req.json();

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if ('headline' in body) update.headline = body.headline;
    if ('article_date' in body) update.article_date = body.article_date || null;
    if ('status' in body) update.status = body.status;
    if ('manual_analysis' in body) update.manual_analysis = body.manual_analysis;

    const { error } = await supabaseAdmin
      .from('articles')
      .update(update)
      .eq('id', id);

    if (error) throw error;

    if ('article_tags' in body) {
      const tags = normalizeTags(body.article_tags);

      const { error: deleteError } = await supabaseAdmin
        .from('article_tags')
        .delete()
        .eq('article_id', id);

      if (deleteError) throw deleteError;

      if (tags.length) {
        const { error: insertError } = await supabaseAdmin
          .from('article_tags')
          .insert(tags.map((tag) => ({ article_id: id, ...tag })));

        if (insertError) throw insertError;
      }
    }

    const { data: article, error: refetchError } = await supabaseAdmin
      .from('articles')
      .select('*, article_tags(*), source_images(id, storage_path, file_name, mime_type)')
      .eq('id', id)
      .single();

    if (refetchError) throw refetchError;

    return Response.json({ article });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const reason = url.searchParams.get('reason') || '';
    const nextStatus = action === 'restore' ? 'ocr_done' : 'deleted';

    const { data: currentArticle, error: currentError } = await supabaseAdmin
      .from('articles')
      .select('manual_analysis')
      .eq('id', id)
      .single();

    if (currentError) throw currentError;

    const manualAnalysis = action === 'restore'
      ? mergeManualAnalysis(currentArticle.manual_analysis, {
          restored_at: new Date().toISOString()
        })
      : mergeManualAnalysis(currentArticle.manual_analysis, {
          deletion_reason: reason || '未指定',
          deleted_at: new Date().toISOString()
        });

    const { data, error } = await supabaseAdmin
      .from('articles')
      .update({
        status: nextStatus,
        manual_analysis: manualAnalysis,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    return Response.json({ article: data });
  } catch (error) {
    return jsonError(error);
  }
}
