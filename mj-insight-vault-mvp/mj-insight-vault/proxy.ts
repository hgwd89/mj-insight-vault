import { NextRequest, NextResponse } from 'next/server';

function allowedCloudStockRequest(method: string, path: string) {
  if (path === '/api/cloud-stock/readiness') return method === 'GET';
  if (path === '/api/cloud-stock/status') return method === 'GET';
  if (path === '/api/cloud-stock/auth') return method === 'GET' || method === 'POST' || method === 'DELETE';
  if (path === '/api/cloud-stock/files') return method === 'GET' || method === 'POST';
  if (path.startsWith('/api/cloud-stock/files/')) return method === 'GET';
  if (path === '/api/cloud-stock/upload') return method === 'POST';
  if (path === '/api/cloud-stock/sync-drive') return method === 'POST';
  if (path === '/api/cloud-stock/ocr') return method === 'POST';
  if (path === '/api/cloud-stock/background') return method === 'GET' || method === 'POST';
  if (path === '/api/internal/cloud-stock-background-worker') return method === 'POST';
  if (path === '/api/cloud-stock/organize') return method === 'GET' || method === 'POST';
  if (path === '/api/cloud-stock/articles') return method === 'GET';
  if (path.startsWith('/api/cloud-stock/articles/')) return method === 'GET';
  if (path === '/api/cloud-stock/legacy-status') return method === 'GET';

  // Neon-native report generation and report history.
  if (path === '/api/chat/jobs') return method === 'GET' || method === 'POST';
  if (/^\/api\/chat\/jobs\/[^/]+$/.test(path)) return method === 'GET';
  if (/^\/api\/chat\/jobs\/[^/]+\/run$/.test(path)) return method === 'POST';
  if (path === '/api/reports') return method === 'GET';
  if (/^\/api\/reports\/[^/]+$/.test(path)) return method === 'GET' || method === 'PATCH' || method === 'DELETE';
  if (path === '/api/diagnostics/latest-report') return method === 'GET';

  // Retired Supabase import routes are reachable only so the handlers can return HTTP 410 Gone.
  if (path === '/api/cloud-stock/import-supabase') return method === 'GET' || method === 'POST';
  if (path === '/api/cloud-stock/import-supabase-db') return method === 'GET' || method === 'POST';
  return false;
}

export function proxy(request: NextRequest) {
  if (allowedCloudStockRequest(request.method.toUpperCase(), request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  return NextResponse.json({
    ok: false,
    retired: true,
    error: 'Supabase系を含む旧APIは退役済みです。Google Drive＋Neonのcanonical APIのみ利用できます。',
    mode: 'google_drive_neon',
    manual_ocr_enabled: true,
    background_ocr_enabled: true,
    article_organization_enabled: true,
    classification_locked: true,
    theme_analysis_locked: true,
    report_locked: false,
    bulk_processing_locked: false
  }, { status: 423 });
}

export const config = {
  matcher: '/api/:path*'
};
