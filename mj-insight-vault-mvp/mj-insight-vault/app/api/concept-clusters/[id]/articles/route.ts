import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getClusterById } from '@/lib/conceptClusters';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;
    const cluster = await getClusterById(id);
    if (!cluster) return Response.json({ error: 'Cluster not found' }, { status: 404 });

    const articleIds = cluster.member_article_ids;
    if (!articleIds.length) return Response.json({ cluster_id: id, cluster_label: cluster.cluster_label, articles: [] });

    const { data, error } = await supabaseAdmin
      .from('articles')
      .select('id, headline, article_date, ocr_text, article_type, status')
      .in('id', articleIds)
      .order('article_date', { ascending: false });
    if (error) throw error;

    return Response.json({
      cluster_id: id,
      cluster_label: cluster.cluster_label,
      cluster_description: cluster.cluster_description,
      source_rollup_months: cluster.source_rollup_months,
      article_count: (data || []).length,
      articles: data || []
    });
  } catch (error) {
    return jsonError(error);
  }
}
