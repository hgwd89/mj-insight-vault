import { NextRequest, NextResponse } from 'next/server';
import { isOcrOnlyMode } from './lib/pipelineMode';

function allowedCloudStockRequest(method: string, path: string) {
  if (path === '/api/cloud-stock/readiness') return method === 'GET';
  if (path === '/api/cloud-stock/status') return method === 'GET';
  if (path === '/api/cloud-stock/auth') return method === 'GET' || method === 'POST' || method === 'DELETE';
  if (path === '/api/cloud-stock/files') return method === 'GET' || method === 'POST';
  if (path === '/api/cloud-stock/upload') return method === 'POST';
  return false;
}

function allowedLowCostStockRequest(request: NextRequest) {
  const method = request.method.toUpperCase();
  const path = request.nextUrl.pathname;
  return allowedCloudStockRequest(method, path);
}

export function proxy(request: NextRequest) {
  if (!isOcrOnlyMode()) return NextResponse.next();
  if (allowedLowCostStockRequest(request)) return NextResponse.next();

  return NextResponse.json({
    ok: false,
    error: 'MJ Insight Vault is running in free cloud-stock mode. Only Google Drive + Neon stock APIs are enabled. Supabase writes, OCR, classification, analysis, reports, and full rollout remain locked.',
    mode: 'ocr_only',
    storage_mode: 'google_drive_neon',
    supabase_mode: 'legacy_frozen',
    ocr_execution_locked: true,
    full_pipeline_locked: true
  }, { status: 423 });
}

export const config = {
  matcher: '/api/:path*'
};
