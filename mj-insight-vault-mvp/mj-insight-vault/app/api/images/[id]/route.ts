import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';

async function softDeleteRelatedArticles(imageId: string) {
  const now = new Date().toISOString();

  const first = await supabaseAdmin
    .from('articles')
    .update({ status: 'deleted', updated_at: now })
    .eq('source_image_id', imageId);

  if (!first.error) return;

  const fallback = await supabaseAdmin
    .from('articles')
    .update({ status: 'deleted' })
    .eq('source_image_id', imageId);

  if (fallback.error) throw fallback.error;
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;

    const { data: image, error: imageError } = await supabaseAdmin
      .from('source_images')
      .select('*')
      .eq('id', id)
      .single();

    if (imageError) throw imageError;

    if (image.storage_path) {
      const remove = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([image.storage_path]);
      if (remove.error) console.error('Storage image removal failed:', remove.error);
    }

    await softDeleteRelatedArticles(id);

    const { data: updatedImage, error: updateError } = await supabaseAdmin
      .from('source_images')
      .update({
        ocr_status: 'deleted',
        error_message: '画像を削除しました。関連する記事候補も不要記事化しました。'
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    return Response.json({ image: updatedImage });
  } catch (error) {
    return jsonError(error);
  }
}
