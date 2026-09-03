export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function retired() {
  return Response.json({
    ok: false,
    retired: true,
    provider: 'supabase',
    storage_mode: 'google_drive_neon',
    error: 'Supabase has been retired from MJ Insight Vault. Google Drive + Neon are the only active storage path.'
  }, {
    status: 410,
    headers: { 'cache-control': 'no-store' }
  });
}

export async function GET() {
  return retired();
}

export async function POST() {
  return retired();
}
