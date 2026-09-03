import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getGoogleDriveBackupConfig, resolveWritableGoogleDriveFolder } from '@/lib/googleDriveBackup';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, NEON_DATA_API_URL } from '@/lib/neonCloud';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const drive = getGoogleDriveBackupConfig();
    const shouldProbe = req.nextUrl.searchParams.get('probe') === '1';
    const writable = shouldProbe
      ? await resolveWritableGoogleDriveFolder(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID)
      : null;

    return Response.json({
      ok: true,
      storage_mode: 'google_drive_neon',
      supabase_mode: 'retired',
      drive: {
        originals_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
        configured_fallback_folder_id: drive.folderId || null,
        has_credentials: drive.hasCredentials,
        service_account_email: drive.clientEmail || null,
        probed: shouldProbe,
        writable: writable?.ok ?? null,
        active_folder_id: writable?.ok ? writable.folderId : null,
        preferred_folder_used: writable?.ok ? writable.folderId === GOOGLE_DRIVE_ORIGINALS_FOLDER_ID : null,
        probe_error: writable && !writable.ok ? writable.error : null
      },
      neon: {
        data_api_configured: Boolean(NEON_DATA_API_URL)
      },
      execution: {
        ocr: false,
        classification: false,
        report: false,
        full_rollout_538: false
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
