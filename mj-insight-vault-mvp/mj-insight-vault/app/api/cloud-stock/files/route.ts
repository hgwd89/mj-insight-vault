import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import {
  GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
  neonDataFetch,
  parseUpstreamJson,
  requireNeonJwt
} from '@/lib/neonCloud';

export const runtime = 'nodejs';

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function nullableDate(value: unknown) {
  const valueText = text(value, 32);
  if (!valueText) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(valueText) ? valueText : null;
}

function contentRangeTotal(value: string | null) {
  if (!value) return null;
  const match = /\/(\d+)$/.exec(value);
  return match ? Number(match[1]) : null;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const mode = text(req.nextUrl.searchParams.get('mode'), 64);

    if (mode === 'pending_ocr') {
      const response = await neonDataFetch(
        'vault_source_files?select=id,drive_file_id,file_name,mime_type,file_size_bytes,ocr_status,created_at&ocr_status=in.(not_started,failed)&mime_type=in.(image/jpeg,image/png,image/webp)&source_status=neq.e2e_test&order=created_at.asc&limit=500',
        jwt,
        {
          method: 'GET',
          headers: { prefer: 'count=exact' }
        }
      );
      const rows = await parseUpstreamJson(response, '未OCR資料の取得に失敗しました。');
      const list = Array.isArray(rows) ? rows : [];
      return Response.json({
        ok: true,
        mode,
        total: contentRangeTotal(response.headers.get('content-range')) ?? list.length,
        rows: list
      });
    }

    const query = text(req.nextUrl.searchParams.get('q'), 500);
    const response = await neonDataFetch('rpc/vault_search_v1', jwt, {
      method: 'POST',
      body: JSON.stringify({ p_query: query, p_limit: 200 })
    });
    const rows = await parseUpstreamJson(response, 'Neon検索に失敗しました。');
    return Response.json({ ok: true, query, rows: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const driveFileId = text(body.drive_file_id, 256);
    const fileName = text(body.file_name, 500);
    if (!driveFileId || !fileName) {
      return Response.json({ error: 'drive_file_id and file_name are required' }, { status: 400 });
    }

    const legacyProvider = text(body.legacy_source_provider, 100) || null;
    const legacyBucket = text(body.legacy_source_bucket, 200) || null;
    const legacyPath = text(body.legacy_source_path, 2000) || null;
    const legacySha256 = text(body.legacy_source_sha256, 128) || null;
    const legacyVerified = body.legacy_copy_verified === true;

    if (legacyPath && (!legacyProvider || !legacyBucket || !/^[a-f0-9]{64}$/i.test(legacySha256 || '') || !legacyVerified)) {
      return Response.json({ error: 'Legacy source provenance is incomplete or unverified.' }, { status: 400 });
    }

    const row = {
      drive_file_id: driveFileId,
      drive_folder_id: text(body.drive_folder_id, 256) || GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
      file_name: fileName,
      mime_type: text(body.mime_type, 200) || null,
      file_size_bytes: Number.isFinite(Number(body.file_size_bytes)) ? Math.max(0, Math.floor(Number(body.file_size_bytes))) : null,
      article_date: nullableDate(body.article_date),
      memo: text(body.memo, 4000) || null,
      source_status: 'stored',
      ocr_status: 'not_started',
      legacy_source_provider: legacyProvider,
      legacy_source_bucket: legacyBucket,
      legacy_source_path: legacyPath,
      legacy_source_sha256: legacySha256,
      legacy_copy_verified_at: legacyVerified ? new Date().toISOString() : null
    };

    const response = await neonDataFetch('vault_source_files?on_conflict=drive_file_id&select=id,drive_file_id,drive_folder_id,file_name,mime_type,file_size_bytes,article_date,memo,source_status,ocr_status,legacy_source_provider,legacy_source_bucket,legacy_source_path,legacy_source_sha256,legacy_copy_verified_at,legacy_source_deleted_at,created_at', jwt, {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row)
    });
    const inserted = await parseUpstreamJson(response, 'Neonへの原本登録に失敗しました。');
    return Response.json({ ok: true, row: Array.isArray(inserted) ? inserted[0] || null : inserted });
  } catch (error) {
    return jsonError(error);
  }
}
