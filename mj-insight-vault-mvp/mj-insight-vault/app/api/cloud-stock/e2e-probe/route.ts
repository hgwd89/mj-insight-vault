import { createHash } from 'node:crypto';
import { downloadGoogleDriveFile, listGoogleDriveFolderFiles } from '@/lib/googleDriveRead';
import { runDocumentOcr } from '@/lib/vision';
import { normalizeOcrText } from '@/lib/text';
import {
  extractNeonCookieHeader,
  fetchNeonJwt,
  GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
  neonAuthFetch,
  neonDataFetch,
  parseUpstreamJson
} from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TEST_DRIVE_FILE_ID = '1NkXyhQs-22UenF9n2iJtr2mYupkA3E8F';
const EXPECTED_FRAGMENT = 'MJ INSIGHT VAULT E2E TEST';

function deriveOwnerCredentials() {
  const appPassword = process.env.APP_PASSWORD || '';
  if (!appPassword) throw new Error('APP_PASSWORD is not configured in this deployment.');
  const digest = createHash('sha256').update(`mj-neon-owner-v1:${appPassword}`, 'utf8').digest('hex');
  const password = `${createHash('sha256').update(`mj-neon-password-v1:${appPassword}`, 'utf8').digest('base64url')}Aa1!`;
  return {
    email: `mj-vault-${digest.slice(0, 20)}@example.com`,
    password,
    name: 'MJ Insight Vault Owner'
  };
}

async function ownerJwt() {
  const credentials = deriveOwnerCredentials();
  let upstream = await neonAuthFetch('/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: credentials.email, password: credentials.password, rememberMe: true })
  });
  if (!upstream.ok && [400, 401, 404].includes(upstream.status)) {
    upstream = await neonAuthFetch('/sign-up/email', {
      method: 'POST',
      body: JSON.stringify(credentials)
    });
  }
  await parseUpstreamJson(upstream, 'Neon Auth E2E sign-in failed.');
  const cookieHeader = extractNeonCookieHeader(upstream.headers);
  if (!cookieHeader) throw new Error('Neon Auth returned no session cookie.');
  return fetchNeonJwt(cookieHeader);
}

export async function GET() {
  try {
    if (process.env.VERCEL_ENV === 'production') {
      return Response.json({ ok: false, error: 'E2E probe is disabled in Production.' }, { status: 404 });
    }

    const files = await listGoogleDriveFolderFiles(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID, 1000);
    const file = files.find((item) => item.id === TEST_DRIVE_FILE_ID);
    if (!file) throw new Error('Synthetic E2E test file is not visible from Google Drive service account.');

    const rawBuffer = await downloadGoogleDriveFile(TEST_DRIVE_FILE_ID);
    if (!rawBuffer.length) throw new Error('Synthetic E2E test file downloaded as empty bytes.');

    const jwt = await ownerJwt();

    let sourceResponse = await neonDataFetch(
      `vault_source_files?drive_file_id=eq.${encodeURIComponent(TEST_DRIVE_FILE_ID)}&select=id,drive_file_id,file_name,mime_type,ocr_status&limit=1`,
      jwt,
      { method: 'GET' }
    );
    let sourceJson = await parseUpstreamJson(sourceResponse, 'Neon source lookup failed.');
    let source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;

    if (!source) {
      sourceResponse = await neonDataFetch('vault_source_files?select=id,drive_file_id,file_name,mime_type,ocr_status', jwt, {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({
          drive_file_id: TEST_DRIVE_FILE_ID,
          drive_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
          file_name: file.name,
          mime_type: file.mimeType,
          file_size_bytes: file.size,
          article_date: null,
          memo: '合成E2Eテスト',
          source_status: 'e2e_test',
          ocr_status: 'not_started'
        })
      });
      sourceJson = await parseUpstreamJson(sourceResponse, 'Neon source insert failed.');
      source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
    }
    if (!source?.id) throw new Error('Neon source row was not created.');
    const sourceFileId = String(source.id);

    let articleResponse = await neonDataFetch(
      `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=eq.0&select=id,ocr_text_raw&limit=1`,
      jwt,
      { method: 'GET' }
    );
    let articleJson = await parseUpstreamJson(articleResponse, 'Neon OCR lookup failed.');
    let article = Array.isArray(articleJson) ? articleJson[0] as Record<string, unknown> | undefined : undefined;
    let ocrText = typeof article?.ocr_text_raw === 'string' ? article.ocr_text_raw : '';

    if (!ocrText.trim()) {
      const ocr = await runDocumentOcr(rawBuffer);
      ocrText = normalizeOcrText(ocr.text || '');
      articleResponse = await neonDataFetch(
        'vault_articles?on_conflict=source_file_id,article_sequence&select=id,ocr_text_raw',
        jwt,
        {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            source_file_id: sourceFileId,
            article_sequence: 0,
            title: file.name,
            ocr_text_raw: ocrText,
            ocr_text_verified: null,
            verification_version: 'preview-e2e-probe-v1',
            verification_status: 'source_ocr_raw',
            confidence: null,
            updated_at: new Date().toISOString()
          })
        }
      );
      articleJson = await parseUpstreamJson(articleResponse, 'Neon OCR insert failed.');
      article = Array.isArray(articleJson) ? articleJson[0] as Record<string, unknown> | undefined : undefined;
      if (!article) throw new Error('Neon OCR row was not created.');

      const statusResponse = await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ ocr_status: 'done', updated_at: new Date().toISOString() })
      });
      await parseUpstreamJson(statusResponse, 'Neon OCR status update failed.');
    }

    const searchResponse = await neonDataFetch('rpc/vault_search_v1', jwt, {
      method: 'POST',
      body: JSON.stringify({ p_query: 'E2E TEST', p_limit: 20 })
    });
    const searchJson = await parseUpstreamJson(searchResponse, 'Neon search RPC failed.');
    const searchRows = Array.isArray(searchJson) ? searchJson as Array<Record<string, unknown>> : [];
    const searchMatched = searchRows.some((row) => String(row.drive_file_id || '') === TEST_DRIVE_FILE_ID);
    const normalizedUpper = ocrText.toUpperCase().replace(/\s+/g, ' ');

    return Response.json({
      ok: rawBuffer.length > 0 && Boolean(sourceFileId) && ocrText.length > 0 && searchMatched,
      drive_visible: true,
      drive_bytes_read: rawBuffer.length,
      neon_auth: true,
      neon_source_registered: true,
      vision_ocr_char_count: ocrText.length,
      vision_expected_fragment_found: normalizedUpper.includes(EXPECTED_FRAGMENT),
      search_matched: searchMatched,
      ocr_preview: ocrText.slice(0, 160)
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
