import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { backupImageToGoogleDrive } from '@/lib/googleDriveBackup';
import {
  GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
  neonDataFetch,
  parseUpstreamJson,
  requireNeonJwt
} from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_BYTES = 3.5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function clean(value: FormDataEntryValue | null, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const form = await req.formData();
    const file = form.get('file');
    const memo = clean(form.get('memo'), 4000);
    const articleDateText = clean(form.get('article_date'), 32);

    if (!(file instanceof File)) return Response.json({ error: 'file is required' }, { status: 400 });
    if (file.size <= 0) return Response.json({ error: '空のファイルは保存できません。' }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) {
      return Response.json({
        error: 'Vercel無料枠の安全上限を超えています。3.5MB以下に圧縮するか、大きいPDFはGoogle Driveへ直接追加してください。',
        max_file_bytes: MAX_FILE_BYTES
      }, { status: 413 });
    }

    const mimeType = (file.type || '').toLowerCase();
    const isPdf = mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf && !ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return Response.json({ error: 'JPG / PNG / WebP / PDFのみ保存できます。' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const drive = await backupImageToGoogleDrive({
      buffer,
      fileName: file.name.slice(0, 500) || `original-${Date.now()}`,
      mimeType: isPdf ? 'application/pdf' : mimeType,
      batchId: `cloud-${new Date().toISOString().slice(0, 10)}`,
      index: Date.now(),
      folderId: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
      description: 'MJ Insight Vault canonical original; Google Drive + Neon stock mode.'
    });

    if (!drive.ok || !drive.file_id) {
      return Response.json({
        error: drive.error || 'Google Driveへの保存に失敗しました。',
        drive_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID
      }, { status: 502 });
    }

    const record = {
      drive_file_id: drive.file_id,
      drive_folder_id: drive.folder_id || GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
      file_name: file.name.slice(0, 500),
      mime_type: isPdf ? 'application/pdf' : mimeType,
      file_size_bytes: file.size,
      article_date: validDate(articleDateText),
      memo: memo || null,
      source_status: 'stored',
      ocr_status: 'not_started'
    };

    const dataResponse = await neonDataFetch('vault_source_files?select=id,drive_file_id,drive_folder_id,file_name,mime_type,file_size_bytes,article_date,memo,source_status,ocr_status,created_at', jwt, {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(record)
    });

    try {
      const inserted = await parseUpstreamJson(dataResponse, 'Google Drive保存後のNeon登録に失敗しました。');
      return Response.json({
        ok: true,
        drive_saved: true,
        neon_registered: true,
        drive: {
          file_id: drive.file_id,
          folder_id: drive.folder_id || GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
          web_view_link: drive.web_view_link || null
        },
        row: Array.isArray(inserted) ? inserted[0] || null : inserted,
        downstream_started: false
      });
    } catch (registrationError) {
      const message = registrationError instanceof Error ? registrationError.message : 'Neon登録に失敗しました。';
      return Response.json({
        error: message,
        drive_saved: true,
        neon_registered: false,
        recovery: {
          drive_file_id: drive.file_id,
          drive_folder_id: drive.folder_id || GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
          file_name: file.name,
          mime_type: record.mime_type,
          file_size_bytes: file.size,
          article_date: record.article_date,
          memo: record.memo
        }
      }, { status: 502 });
    }
  } catch (error) {
    return jsonError(error);
  }
}
