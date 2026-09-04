import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';
import { downloadGoogleDriveFile } from '@/lib/googleDriveRead';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await context.params;
    const sourceFileId = clean(id, 100);
    if (!sourceFileId) return Response.json({ error: '原本IDがありません。' }, { status: 400 });

    const sourceResponse = await neonDataFetch(
      `vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}&source_status=neq.e2e_test&select=id,drive_file_id,file_name,mime_type,file_size_bytes&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const sourceJson = await parseUpstreamJson(sourceResponse, '原本情報を取得できませんでした。');
    const source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
    if (!source) return Response.json({ error: '原本が見つかりません。' }, { status: 404 });

    const driveFileId = clean(source.drive_file_id, 500);
    if (!driveFileId) return Response.json({ error: 'Google Drive原本が紐づいていません。' }, { status: 404 });

    const bytes = await downloadGoogleDriveFile(driveFileId);
    const fileName = clean(source.file_name, 500) || 'original';
    const mimeType = clean(source.mime_type, 200) || 'application/octet-stream';

    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': mimeType,
        'content-length': String(bytes.length),
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'cache-control': 'private, no-store'
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
