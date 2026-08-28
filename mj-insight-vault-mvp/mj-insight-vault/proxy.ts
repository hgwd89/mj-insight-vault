import { NextRequest, NextResponse } from 'next/server';
import { isOcrOnlyMode } from './lib/pipelineMode';

function allowedCloudStockRequest(method: string, path: string) {
  if (path === '/api/cloud-stock/status') return method === 'GET';
  if (path === '/api/cloud-stock/auth') return method === 'GET' || method === 'POST' || method === 'DELETE';
  if (path === '/api/cloud-stock/files') return method === 'GET' || method === 'POST';
  if (path === '/api/cloud-stock/upload') return method === 'POST';
  return false;
}

function allowedOcrOnlyRequest(request: NextRequest) {
  const method = request.method.toUpperCase();
  const path = request.nextUrl.pathname;

  if (allowedCloudStockRequest(method, path)) return true;

  if (method === 'GET' && path === '/api/batches') return true;
  if (method === 'GET' && /^\/api\/ocr-stock\/batches\/[^/]+$/.test(path)) return true;

  if (method !== 'POST') return false;
  if (path === '/api/upload' || path === '/api/upload/start' || path === '/api/upload/image') return true;
  if (/^\/api\/source-images\/[^/]+\/ocr-only$/.test(path)) return true;

  return false;
}

export function proxy(request: NextRequest) {
  if (!isOcrOnlyMode()) return NextResponse.next();
  if (allowedOcrOnlyRequest(request)) return NextResponse.next();

  return NextResponse.json({
    ok: false,
    error: 'MJ Insight Vault is running in low-cost stock mode. Google Drive + Neon stock APIs and legacy OCR-only safety routes are enabled; full downstream remains locked.',
    mode: 'ocr_only',
    full_pipeline_locked: true
  }, { status: 423 });
}

export const config = {
  matcher: '/api/:path*'
};
