export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function retired() {
  return Response.json({
    ok: false,
    retired: true,
    provider: 'supabase',
    storage_mode: 'google_drive_neon',
    replacement: '/api/cloud-stock/articles',
    error: 'Legacy Supabase article API is retired. Use the Google Drive + Neon article API.'
  }, {
    status: 410,
    headers: { 'cache-control': 'no-store' }
  });
}

export async function GET() {
  return retired();
}
