import { NextRequest, NextResponse } from 'next/server';
import { isOcrOnlyMode } from './lib/pipelineMode';

function allowedOcrOnlyRequest(request: NextRequest) {
  const method = request.method.toUpperCase();
  const path = request.nextUrl.pathname;

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
    error: 'MJ Insight Vault is running in OCR-only low-cost mode. Only stock upload, OCR stock reads, and explicit single-image OCR are enabled.',
    mode: 'ocr_only',
    full_pipeline_locked: true
  }, { status: 423 });
}

export const config = {
  matcher: '/api/:path*'
};
