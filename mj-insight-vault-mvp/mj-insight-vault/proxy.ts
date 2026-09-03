import { NextRequest, NextResponse } from 'next/server';
import { isOcrOnlyMode } from './lib/pipelineMode';

function allowedCloudStockRequest(method: string, path: string) {
  if (path === '/api/cloud-stock/readiness') return method === 'GET';
  if (path === '/api/cloud-stock/status') return method === 'GET';
  if (path === '/api/cloud-stock/auth') return method === 'GET' || method === 'POST' || method === 'DELETE';
  if (path === '/api/cloud-stock/files') return method === 'GET' || method === 'POST';
  if (path === '/api/cloud-stock/sync-drive') return method === 'POST';
  if (path === '/api/cloud-stock/ocr') return method === 'POST';
  if (path === '/api/cloud-stock/e2e-probe') return method === 'GET';
  return false;
}

function allowedLowCostStockRequest(request: NextRequest) {
  return allowedCloudStockRequest(request.method.toUpperCase(), request.nextUrl.pathname);
}

export function proxy(request: NextRequest) {
  if (!isOcrOnlyMode()) return NextResponse.next();
  if (allowedLowCostStockRequest(request)) return NextResponse.next();

  return NextResponse.json({
    ok: false,
    error: '現在はGoogleドライブ＋Neon運用です。このAPIは停止中です。資料同期・手動OCR・検索のみ利用できます。',
    mode: 'google_drive_neon',
    manual_ocr_enabled: true,
    automatic_processing_locked: true,
    classification_locked: true,
    theme_analysis_locked: true,
    report_locked: true,
    bulk_processing_locked: true
  }, { status: 423 });
}

export const config = {
  matcher: '/api/:path*'
};
