import { NextRequest } from 'next/server';
import { jsonError, requireAppPassword } from '@/lib/auth';
import {
  backgroundWorkerToken,
  pendingOcrCount,
  resetFailedOcr
} from '@/lib/cloudStockBackgroundOcr';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';

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

    const workerUrl = new URL('/api/internal/cloud-stock-background-worker', req.url);
    const workerResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${backgroundWorkerToken()}` },
      cache: 'no-store'
    });

    if (!workerResponse.ok) {
      const text = await workerResponse.text().catch(() => '');
      throw new Error(`バックグラウンドOCRを開始できませんでした。${text.slice(0, 300)}`);
    }

    const remaining = await pendingOcrCount(jwt);
    return Response.json({
      ok: true,
      started: remaining > 0,
      remaining,
      can_close_app: true,
      message: remaining > 0
        ? 'バックグラウンドOCRを開始しました。アプリを閉じても処理は継続します。'
        : '未OCR資料はありません。'
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}
