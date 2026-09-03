import { getGoogleDriveBackupConfig, inspectGoogleDriveFolder } from '@/lib/googleDriveBackup';
import { probeGoogleDriveFolderRead } from '@/lib/googleDriveRead';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, NEON_DATA_API_URL } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const config = getGoogleDriveBackupConfig();
  const [driveReadProbe, driveWriteProbe] = await Promise.all([
    probeGoogleDriveFolderRead(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID),
    inspectGoogleDriveFolder(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID)
  ]);
  const neonConfigured = Boolean(NEON_DATA_API_URL);
  const ready = driveReadProbe.ok && driveWriteProbe.ok && neonConfigured;

  return Response.json({
    ok: ready,
    storage_mode: 'google_drive_neon',
    drive: {
      configured: true,
      originals_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
      readable_and_syncable: driveReadProbe.ok,
      writable: driveWriteProbe.ok,
      writable_check: 'drive_capability_canAddChildren',
      can_add_children: driveWriteProbe.canAddChildren ?? false,
      visible_file_count: driveReadProbe.fileCount,
      file_content_readable: driveReadProbe.firstFileReadable,
      service_account_email: config.clientEmail || null,
      error: driveReadProbe.error || driveWriteProbe.error
    },
    neon: {
      data_api_configured: neonConfigured,
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
    status: ready ? 200 : 503,
    headers: { 'cache-control': 'no-store' }
  });
}
