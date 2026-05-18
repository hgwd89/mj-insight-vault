import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONFIRM_TEXT = 'DELETE_REUPLOAD_DATA';
const CHUNK_SIZE = 100;

type Counts = {
  batches: number;
  source_images: number;
  articles: number;
  article_embeddings: number;
  chat_reports: number;
  storage_files: number;
};

function chunk<T>(items: T[], size = CHUNK_SIZE) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function countTable(table: string) {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select('*', { count: 'exact', head: true });

  if (error) throw error;
  return count || 0;
}

async function collectIdsAndPaths() {
  const { data: articles, error: articleError } = await supabaseAdmin
    .from('articles')
    .select('id');

  if (articleError) throw articleError;

  const { data: images, error: imageError } = await supabaseAdmin
    .from('source_images')
    .select('id, storage_path');

  if (imageError) throw imageError;

  return {
    articleIds: (articles || []).map((a) => String(a.id)).filter(Boolean),
    imageIds: (images || []).map((i) => String(i.id)).filter(Boolean),
    storagePaths: Array.from(new Set((images || []).map((i) => String(i.storage_path || '').trim()).filter(Boolean)))
  };
}

async function getCounts(): Promise<Counts> {
  const { articleIds, storagePaths } = await collectIdsAndPaths();
  let embeddingCount = 0;

  for (const ids of chunk(articleIds)) {
    const { count, error } = await supabaseAdmin
      .from('article_embeddings')
      .select('*', { count: 'exact', head: true })
      .in('article_id', ids);

    if (error) throw error;
    embeddingCount += count || 0;
  }

  return {
    batches: await countTable('upload_batches'),
    source_images: await countTable('source_images'),
    articles: await countTable('articles'),
    article_embeddings: embeddingCount,
    chat_reports: await countTable('chat_reports'),
    storage_files: storagePaths.length
  };
}

async function deleteByIds(table: string, column: string, ids: string[]) {
  let deleted = 0;

  for (const part of chunk(ids)) {
    if (!part.length) continue;

    const { error, count } = await supabaseAdmin
      .from(table)
      .delete({ count: 'exact' })
      .in(column, part);

    if (error) throw error;
    deleted += count || part.length;
  }

  return deleted;
}

async function deleteAllRows(table: string) {
  const { error, count } = await supabaseAdmin
    .from(table)
    .delete({ count: 'exact' })
    .not('id', 'is', null);

  if (error) throw error;
  return count || 0;
}

async function removeStorageFiles(paths: string[]) {
  let removed = 0;
  const errors: string[] = [];

  for (const part of chunk(paths)) {
    if (!part.length) continue;

    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .remove(part);

    if (error) {
      errors.push(error.message);
      continue;
    }

    removed += data?.length || part.length;
  }

  return { removed, errors };
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const counts = await getCounts();

    return Response.json({
      confirm_text: CONFIRM_TEXT,
      counts,
      note: '再OCRのための全削除プレビューです。実行すると画像・記事・embedding・分析レポートを削除できます。'
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const confirm = String(body.confirm || '');
    const includeReports = body.include_reports !== false;

    if (confirm !== CONFIRM_TEXT) {
      return Response.json({ error: `confirm must be ${CONFIRM_TEXT}` }, { status: 400 });
    }

    const before = await getCounts();
    const { articleIds, imageIds, storagePaths } = await collectIdsAndPaths();

    const deletedEmbeddings = await deleteByIds('article_embeddings', 'article_id', articleIds);
    const deletedReports = includeReports ? await deleteAllRows('chat_reports') : 0;
    const deletedArticles = await deleteByIds('articles', 'id', articleIds);
    const deletedImages = await deleteByIds('source_images', 'id', imageIds);
    const deletedBatches = await deleteAllRows('upload_batches');
    const storage = await removeStorageFiles(storagePaths);
    const after = await getCounts();

    return Response.json({
      ok: true,
      before,
      after,
      deleted: {
        article_embeddings: deletedEmbeddings,
        chat_reports: deletedReports,
        articles: deletedArticles,
        source_images: deletedImages,
        upload_batches: deletedBatches,
        storage_files: storage.removed
      },
      storage_errors: storage.errors,
      include_reports: includeReports
    });
  } catch (error) {
    return jsonError(error);
  }
}
