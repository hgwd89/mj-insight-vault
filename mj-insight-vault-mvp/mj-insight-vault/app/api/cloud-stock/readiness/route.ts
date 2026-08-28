import { resolveWritableGoogleDriveFolder } from '@/lib/googleDriveBackup';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, NEON_DATA_API_URL } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const destination = await resolveWritableGoogleDriveFolder(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID);
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
      error: destination.ok ? null : destination.error
    },
    neon: {
      data_api_configured: Boolean(NEON_DATA_API_URL),
      schema_managed_separately: true
    },
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
