import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { jsonError, requireAppPassword } from '@/lib/auth';
import { pendingOcrCount, pendingOrganizeCount, resetFailedOcr } from '@/lib/cloudStockBackgroundOcr';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';
import { cloudStockOcrWorkflow } from '@/workflows/cloud-stock-ocr';

export const runtime = 'nodejs';

async function countByStatus(jwt: string, status: string) {
  const response = await neonDataFetch(
    `vault_source_files?select=id&ocr_status=eq.${encodeURIComponent(status)}&mime_type=in.(image/jpeg,image/png,image/webp)&source_status=neq.e2e_test&limit=5000`,
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, 'OCR状態を取得できませんでした。');
  return Array.isArray(json) ? json.length : 0;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const [remaining, organizeRemaining, processing, failed] = await Promise.all([
      pendingOcrCount(jwt),
      pendingOrganizeCount(jwt),
      countByStatus(jwt, 'processing'),
      countByStatus(jwt, 'failed')
    ]);

    return Response.json({
      ok: true,
      background_enabled: true,
      durable_workflow: true,
      remaining,
      organize_remaining: organizeRemaining,
      total_remaining: remaining + organizeRemaining,
      processing,
      failed,
      can_close_app: true
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    await resetFailedOcr(jwt);

    const [remaining, organizeRemaining] = await Promise.all([
      pendingOcrCount(jwt),
      pendingOrganizeCount(jwt)
    ]);
    const totalRemaining = remaining + organizeRemaining;

    if (totalRemaining === 0) {
      return Response.json({
        ok: true,
        started: false,
        remaining: 0,
        organize_remaining: 0,
        total_remaining: 0,
        can_close_app: true,
        message: '未処理資料はありません。'
      });
    }

    const run = await start(cloudStockOcrWorkflow, []);

    return Response.json({
      ok: true,
      started: true,
      run_id: run.runId,
      remaining,
      organize_remaining: organizeRemaining,
      total_remaining: totalRemaining,
      can_close_app: true,
      durable_workflow: true,
      message: `バックグラウンド処理を開始しました。未OCR ${remaining}件／記事整理待ち ${organizeRemaining}件。アプリを閉じても処理は継続します。`
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
