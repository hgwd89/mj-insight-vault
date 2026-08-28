import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getGoogleDriveBackupConfig } from '@/lib/googleDriveBackup';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, NEON_DATA_API_URL } from '@/lib/neonCloud';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const drive = getGoogleDriveBackupConfig();
    return Response.json({
      ok: true,
      storage_mode: 'google_drive_neon',
      supabase_mode: 'legacy_frozen',
      drive: {
        originals_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
        has_credentials: drive.hasCredentials,
        service_account_email: drive.clientEmail || null
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
