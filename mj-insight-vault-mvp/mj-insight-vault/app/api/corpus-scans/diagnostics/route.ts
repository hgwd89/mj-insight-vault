import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);

    const { count: activeArticles, error: articleError } = await supabaseAdmin
      .from('articles')
      .select('*', { count: 'exact', head: true })
      .not('status', 'in', '(deleted,excluded,rejected)');
    if (articleError) throw articleError;

    const { data: latestRun, error: runError } = await supabaseAdmin
      .from('full_corpus_scan_runs')
      .select('*')
      .eq('scope_type', 'all')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runError) throw runError;

    const analyzed = Number(latestRun?.analyzed_article_count || 0);
    const ocrReady = Number(latestRun?.ocr_ready_article_count || 0);
    const totalBatches = Number(latestRun?.total_batches || 0);
    const completedBatches = Number(latestRun?.completed_batches || 0);
    const failedBatches = Number(latestRun?.failed_batches || 0);
    const fullCorpusPassed = Boolean(latestRun && latestRun.status === 'completed' && analyzed > 0 && analyzed === ocrReady && completedBatches === totalBatches && failedBatches === 0);

    return Response.json({
      status: fullCorpusPassed ? 'pass' : 'fail',
      full_corpus_gate: fullCorpusPassed ? 'passed' : 'failed',
      active_article_count: activeArticles || 0,
      latest_run: latestRun,
      checks: [
        {
          key: 'scan_run_exists',
          passed: Boolean(latestRun),
          expected: 'latest full corpus scan run exists',
          actual: Boolean(latestRun)
        },
        {
          key: 'all_ocr_ready_articles_analyzed',
          passed: analyzed > 0 && analyzed === ocrReady,
          expected: 'analyzed_article_count equals ocr_ready_article_count',
          actual: { analyzed_article_count: analyzed, ocr_ready_article_count: ocrReady }
        },
        {
          key: 'all_batches_completed',
          passed: totalBatches > 0 && completedBatches === totalBatches,
          expected: 'completed_batches equals total_batches',
          actual: { completed_batches: completedBatches, total_batches: totalBatches }
        },
        {
          key: 'no_failed_batches',
          passed: failedBatches === 0,
          expected: 'failed_batches is 0',
          actual: failedBatches
        }
      ]
    });
  } catch (error) {
    return jsonError(error);
  }
}
