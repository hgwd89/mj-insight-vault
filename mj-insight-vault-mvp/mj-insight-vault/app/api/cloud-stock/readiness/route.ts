import { getGoogleDriveBackupConfig, resolveWritableGoogleDriveFolder } from '@/lib/googleDriveBackup';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, NEON_DATA_API_URL } from '@/lib/neonCloud';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function probeLegacySupabaseStorage() {
  try {
    const { error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).list('', {
      limit: 1,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' }
    });
    return {
      configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      reachable: !error,
      bucket: STORAGE_BUCKET,
      error: error ? error.message.slice(0, 240) : null
    };
  } catch (error) {
    return {
      configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      reachable: false,
      bucket: STORAGE_BUCKET,
      error: error instanceof Error ? error.message.slice(0, 240) : 'Storage probe failed.'
    };
  }
}

export async function GET() {
  const config = getGoogleDriveBackupConfig();
  const [destination, legacyStorage] = await Promise.all([
    resolveWritableGoogleDriveFolder(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID),
    probeLegacySupabaseStorage()
  ]);
  return Response.json({
    ok: destination.ok,
    storage_mode: 'google_drive_neon',
    supabase_mode: 'legacy_frozen',
    drive: {
      configured: true,
      preferred_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
      writable: destination.ok,
      active_folder_id: destination.ok ? destination.folderId : null,
      preferred_folder_used: destination.ok ? destination.folderId === GOOGLE_DRIVE_ORIGINALS_FOLDER_ID : false,
      service_account_email: config.clientEmail || null,
      error: destination.ok ? null : destination.error
    },
    neon: {
      data_api_configured: Boolean(NEON_DATA_API_URL),
      schema_managed_separately: true
    },
    legacy_supabase_storage: legacyStorage,
    execution: {
      ocr: false,
      classification: false,
      report: false,
      full_rollout_538: false
    }
  }, {
    status: destination.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' }
  });
}
