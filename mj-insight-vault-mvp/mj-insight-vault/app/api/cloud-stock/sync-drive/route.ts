import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { listGoogleDriveFolderFiles } from '@/lib/googleDriveRead';
import {
  GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
  neonDataFetch,
  parseUpstreamJson,
  requireNeonJwt
} from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const driveFiles = await listGoogleDriveFolderFiles(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, 1000);

    const existingResponse = await neonDataFetch('vault_source_files?select=drive_file_id&limit=5000', jwt, {
      method: 'GET'
    });
    const existingJson = await parseUpstreamJson(existingResponse, '登録済み資料の確認に失敗しました。');
    const existingIds = new Set(
      (Array.isArray(existingJson) ? existingJson : [])
        .map((row) => row && typeof row === 'object' && 'drive_file_id' in row ? String((row as { drive_file_id?: unknown }).drive_file_id || '') : '')
        .filter(Boolean)
    );

    const newFiles = driveFiles.filter((file) => !existingIds.has(file.id));
    if (newFiles.length) {
      const rows = newFiles.map((file) => ({
        drive_file_id: file.id,
        drive_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
        file_name: file.name,
        mime_type: file.mimeType || null,
        file_size_bytes: file.size,
        article_date: null,
        memo: null,
        source_status: 'stored',
        ocr_status: 'not_started'
      }));
      const insertResponse = await neonDataFetch('vault_source_files?on_conflict=drive_file_id', jwt, {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      });
      await parseUpstreamJson(insertResponse, 'Googleドライブの資料をデータベースへ登録できませんでした。');
    }

    return Response.json({
      ok: true,
      drive_files: driveFiles.length,
      already_registered: driveFiles.length - newFiles.length,
      newly_registered: newFiles.length,
      downstream_started: false
    });
  } catch (error) {
    return jsonError(error);
  }
}
