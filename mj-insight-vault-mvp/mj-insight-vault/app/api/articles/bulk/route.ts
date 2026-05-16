import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type BulkAction = 'delete' | 'restore' | 'set_date' | 'set_status' | 'add_tags';

type TagInput = {
  tag_type?: string;
  tag_name?: string;
};

function normalizeIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((id) => String(id || '').trim()).filter(Boolean))).slice(0, 200);
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const tags: { tag_type: string; tag_name: string }[] = [];

  for (const item of value as TagInput[]) {
    const tagType = String(item?.tag_type || '').trim();
    const tagName = String(item?.tag_name || '').trim();
    if (!tagType || !tagName) continue;

    const key = `${tagType}::${tagName}`;
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push({ tag_type: tagType, tag_name: tagName });
  }

  return tags.slice(0, 20);
}

function mergeManualAnalysis(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};

  return { ...base, ...patch };
}

async function updateArticlesStatus(ids: string[], status: string, reason?: string) {
  if (!reason) {
    const { data, error } = await supabaseAdmin
      .from('articles')
      .update({ status, updated_at: new Date().toISOString() })
      .in('id', ids)
      .select('id');

    if (!error) return data || [];

    const fallback = await supabaseAdmin
      .from('articles')
      .update({ status })
      .in('id', ids)
      .select('id');

    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }

  const { data: current, error: currentError } = await supabaseAdmin
    .from('articles')
    .select('id, manual_analysis')
    .in('id', ids);

  if (currentError) throw currentError;

  const updated: { id: string }[] = [];

  for (const article of current || []) {
    const manualAnalysis = mergeManualAnalysis(article.manual_analysis, {
      deletion_reason: reason,
      deleted_at: new Date().toISOString(),
      bulk_operation: true
    });

    const first = await supabaseAdmin
      .from('articles')
      .update({ status, manual_analysis: manualAnalysis, updated_at: new Date().toISOString() })
      .eq('id', article.id)
      .select('id')
      .single();

    if (!first.error) {
      updated.push(first.data);
      continue;
    }

    const fallback = await supabaseAdmin
      .from('articles')
      .update({ status, manual_analysis: manualAnalysis })
      .eq('id', article.id)
      .select('id')
      .single();

    if (fallback.error) throw fallback.error;
    updated.push(fallback.data);
  }

  return updated;
}

async function updateArticlesDate(ids: string[], articleDate: string | null) {
  const first = await supabaseAdmin
    .from('articles')
    .update({ article_date: articleDate, updated_at: new Date().toISOString() })
    .in('id', ids)
    .select('id');

  if (!first.error) return first.data || [];

  const fallback = await supabaseAdmin
    .from('articles')
    .update({ article_date: articleDate })
    .in('id', ids)
    .select('id');

  if (fallback.error) throw fallback.error;
  return fallback.data || [];
}

async function addTags(ids: string[], tags: { tag_type: string; tag_name: string }[]) {
  if (!tags.length) return [];

  const rows = ids.flatMap((articleId) => tags.map((tag) => ({ article_id: articleId, ...tag })));

  const { error } = await supabaseAdmin
    .from('article_tags')
    .upsert(rows, { onConflict: 'article_id,tag_type,tag_name' });

  if (error) {
    // Some projects may not have a unique constraint for upsert. Fall back to best-effort insert.
    const inserted: unknown[] = [];
    for (const row of rows) {
      const result = await supabaseAdmin.from('article_tags').insert(row).select('*').single();
      if (!result.error) inserted.push(result.data);
    }
    return inserted;
  }

  return rows;
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const body = await req.json();
    const action = String(body.action || '') as BulkAction;
    const ids = normalizeIds(body.article_ids);

    if (!ids.length) return Response.json({ error: 'article_ids are required' }, { status: 400 });

    if (action === 'delete') {
      const reason = String(body.reason || '一括不要化').trim();
      const updated = await updateArticlesStatus(ids, 'deleted', reason);
      return Response.json({ ok: true, action, updated_count: updated.length, article_ids: updated.map((a) => a.id) });
    }

    if (action === 'restore') {
      const updated = await updateArticlesStatus(ids, 'ocr_done');
      return Response.json({ ok: true, action, updated_count: updated.length, article_ids: updated.map((a) => a.id) });
    }

    if (action === 'set_date') {
      const articleDate = String(body.article_date || '').trim() || null;
      const updated = await updateArticlesDate(ids, articleDate);
      return Response.json({ ok: true, action, updated_count: updated.length, article_ids: updated.map((a) => a.id) });
    }

    if (action === 'set_status') {
      const status = String(body.status || '').trim();
      if (!status) return Response.json({ error: 'status is required' }, { status: 400 });
      const updated = await updateArticlesStatus(ids, status);
      return Response.json({ ok: true, action, updated_count: updated.length, article_ids: updated.map((a) => a.id) });
    }

    if (action === 'add_tags') {
      const tags = normalizeTags(body.tags);
      if (!tags.length) return Response.json({ error: 'tags are required' }, { status: 400 });
      const updated = await addTags(ids, tags);
      return Response.json({ ok: true, action, updated_count: updated.length });
    }

    return Response.json({ error: 'Unsupported bulk action' }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}
