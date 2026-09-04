export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function retired() {
  return Response.json({
    ok: false,
    retired: true,
    provider: 'supabase',
    storage_mode: 'google_drive_neon',
    replacement: '/cloud-stock',
    error: 'Legacy Supabase article detail API is retired. Use Google Drive + Neon article detail.'
  }, {
    status: 410,
    headers: { 'cache-control': 'no-store' }
  });
}

export async function GET() {
  return retired();
}

export async function PATCH() {
  return retired();
}

export async function DELETE() {
  return retired();
}
