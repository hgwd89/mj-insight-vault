export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  return Response.json({
    ok: false,
    retired: true,
    provider: 'supabase',
    storage_mode: 'google_drive_neon',
    replacement: '/cloud-stock',
    error: 'Legacy Supabase article bulk API is retired.'
  }, {
    status: 410,
    headers: { 'cache-control': 'no-store' }
  });
}
