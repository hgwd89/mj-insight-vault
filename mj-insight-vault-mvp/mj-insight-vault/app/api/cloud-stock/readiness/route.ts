import { getGoogleDriveBackupConfig, resolveWritableGoogleDriveFolder } from '@/lib/googleDriveBackup';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, NEON_DATA_API_URL } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const config = getGoogleDriveBackupConfig();
  const destination = await resolveWritableGoogleDriveFolder(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID);

  return Response.json({
    ok: destination.ok && Boolean(NEON_DATA_API_URL),
    storage_mode: 'google_drive_neon',
    drive: {
      configured: true,
      originals_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
      readable_and_syncable: destination.ok,
      active_folder_id: destination.ok ? destination.folderId : null,
      service_account_email: config.clientEmail || null,
      error: destination.ok ? null : destination.error
    },
    neon: {
      data_api_configured: Boolean(NEON_DATA_API_URL),
      schema_managed_separately: true
    },
    execution: {
      manual_ocr: true,
      automatic_ocr: false,
      classification: false,
      theme_analysis: false,
      report: false,
      bulk_processing: false
    }
  }, {
    status: destination.ok && NEON_DATA_API_URL ? 200 : 503,
    headers: { 'cache-control': 'no-store' }
  });
}
