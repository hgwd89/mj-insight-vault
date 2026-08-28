import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const response = await neonDataFetch(
      'vault_source_files?legacy_source_provider=eq.supabase_storage&select=drive_file_id,file_size_bytes,legacy_source_bucket,legacy_source_path,legacy_source_sha256,legacy_copy_verified_at,legacy_source_deleted_at',
      jwt,
      { method: 'GET' }
    );
    const data = await parseUpstreamJson(response, 'Neon legacy rescue status read failed.');
    const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    const copied = rows.length;
    const verified = rows.filter((row) => Boolean(row.legacy_copy_verified_at) && typeof row.legacy_source_sha256 === 'string').length;
    const deleted = rows.filter((row) => Boolean(row.legacy_source_deleted_at)).length;
    const bytes = rows.reduce((sum, row) => {
      const value = Number(row.file_size_bytes || 0);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);

    return Response.json({
      ok: true,
      source: 'supabase_storage',
      copied,
      verified,
      deleted,
      retained_in_supabase: Math.max(0, copied - deleted),
      copied_bytes: bytes,
      deletion_released: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
