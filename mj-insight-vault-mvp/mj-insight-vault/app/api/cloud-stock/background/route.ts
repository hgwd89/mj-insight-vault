import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { jsonError, requireAppPassword } from '@/lib/auth';
import { pendingOcrCount, resetFailedOcr } from '@/lib/cloudStockBackgroundOcr';
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
    const [remaining, processing, failed] = await Promise.all([
      pendingOcrCount(jwt),
      countByStatus(jwt, 'processing'),
      countByStatus(jwt, 'failed')
    ]);

    return Response.json({
      ok: true,
      background_enabled: true,
      durable_workflow: true,
      remaining,
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

    const remaining = await pendingOcrCount(jwt);
    if (remaining === 0) {
      return Response.json({
        ok: true,
        started: false,
        remaining: 0,
        can_close_app: true,
        message: '未OCR資料はありません。'
      });
    }

    const run = await start(cloudStockOcrWorkflow, []);

    return Response.json({
      ok: true,
      started: true,
      run_id: run.runId,
      remaining,
      can_close_app: true,
      durable_workflow: true,
      message: 'バックグラウンドOCRを開始しました。アプリを閉じても処理は継続します。'
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
