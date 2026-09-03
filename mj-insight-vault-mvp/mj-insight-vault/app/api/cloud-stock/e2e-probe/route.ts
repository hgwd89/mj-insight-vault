import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as syncDrivePost } from '@/app/api/cloud-stock/sync-drive/route';
import { POST as ocrPost } from '@/app/api/cloud-stock/ocr/route';
import { GET as filesGet } from '@/app/api/cloud-stock/files/route';
import {
  extractNeonCookieHeader,
  fetchNeonJwt,
  neonAuthFetch,
  neonDataFetch,
  parseUpstreamJson
} from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TEST_DRIVE_FILE_ID = '1NkXyhQs-22UenF9n2iJtr2mYupkA3E8F';
const EXPECTED_FRAGMENT = 'MJ INSIGHT VAULT E2E TEST';
const SESSION_COOKIE = 'mj_neon_session';

function deriveOwnerCredentials() {
  const appPassword = process.env.APP_PASSWORD || '';
  if (!appPassword) throw new Error('APP_PASSWORD is not configured in this deployment.');
  const digest = createHash('sha256').update(`mj-neon-owner-v1:${appPassword}`, 'utf8').digest('hex');
  const password = `${createHash('sha256').update(`mj-neon-password-v1:${appPassword}`, 'utf8').digest('base64url')}Aa1!`;
  return {
    appPassword,
    email: `mj-vault-${digest.slice(0, 20)}@example.com`,
    password,
    name: 'MJ Insight Vault Owner'
  };
}

async function ownerSession() {
  const credentials = deriveOwnerCredentials();
  let upstream = await neonAuthFetch('/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: credentials.email, password: credentials.password, rememberMe: true })
  });
  if (!upstream.ok && [400, 401, 404].includes(upstream.status)) {
    upstream = await neonAuthFetch('/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email: credentials.email, password: credentials.password, name: credentials.name })
    });
  }
  await parseUpstreamJson(upstream, 'Neon Auth E2E sign-in failed.');
  const cookieHeader = extractNeonCookieHeader(upstream.headers);
  if (!cookieHeader) throw new Error('Neon Auth returned no session cookie.');
  const jwt = await fetchNeonJwt(cookieHeader);
  const encodedProxyCookie = Buffer.from(cookieHeader, 'utf8').toString('base64url');
  return {
    appPassword: credentials.appPassword,
    jwt,
    proxyCookie: `${SESSION_COOKIE}=${encodedProxyCookie}`
  };
}

async function responseJson(response: Response, label: string) {
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`${label}: non-JSON response ${response.status} ${text.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(`${label}: ${response.status} ${String(json.error || text)}`);
  return json;
}

export async function GET() {
  try {
    if (process.env.VERCEL_ENV === 'production') {
      return Response.json({ ok: false, error: 'E2E probe is disabled in Production.' }, { status: 404 });
    }

    const session = await ownerSession();
    const baseHeaders = {
      'x-app-password': session.appPassword,
      cookie: session.proxyCookie
    };

    // 1) Execute the exact production sync handler.
    const syncRequest = new NextRequest('https://preview.local/api/cloud-stock/sync-drive', {
      method: 'POST',
      headers: baseHeaders
    });
    const syncResult = await responseJson(await syncDrivePost(syncRequest), 'sync-drive');

    // Locate the synthetic source row through the same owner JWT.
    const sourceResponse = await neonDataFetch(
      `vault_source_files?drive_file_id=eq.${encodeURIComponent(TEST_DRIVE_FILE_ID)}&select=id,drive_file_id,file_name,mime_type,ocr_status&limit=1`,
      session.jwt,
      { method: 'GET' }
    );
    const sourceJson = await parseUpstreamJson(sourceResponse, 'E2E source lookup failed.');
    const source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
    if (!source?.id) throw new Error('sync-drive did not produce a visible source row.');
    const sourceFileId = String(source.id);

    // Reset only the synthetic test row so the exact OCR handler must call Vision again.
    const resetArticle = await neonDataFetch(
      `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=eq.0`,
      session.jwt,
      {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          ocr_text_raw: null,
          ocr_text_verified: null,
          verification_version: 'preview-e2e-reset',
          verification_status: 'pending',
          updated_at: new Date().toISOString()
        })
      }
    );
    await parseUpstreamJson(resetArticle, 'E2E OCR reset failed.');
    const resetSource = await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, session.jwt, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ocr_status: 'not_started', updated_at: new Date().toISOString() })
    });
    await parseUpstreamJson(resetSource, 'E2E source reset failed.');

    // 2) Execute the exact production OCR handler (Drive download -> Vision -> Neon).
    const ocrRequest = new NextRequest('https://preview.local/api/cloud-stock/ocr', {
      method: 'POST',
      headers: { ...baseHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ source_file_id: sourceFileId })
    });
    const ocrResult = await responseJson(await ocrPost(ocrRequest), 'ocr');

    // 3) Execute the exact production files/search handler.
    const filesRequest = new NextRequest('https://preview.local/api/cloud-stock/files?q=E2E%20TEST', {
      method: 'GET',
      headers: baseHeaders
    });
    const filesResult = await responseJson(await filesGet(filesRequest), 'files');
    const rows = Array.isArray(filesResult.rows) ? filesResult.rows as Array<Record<string, unknown>> : [];
    const matched = rows.find((row) => String(row.drive_file_id || '') === TEST_DRIVE_FILE_ID);
    const preview = matched && typeof matched.matched_text_preview === 'string' ? matched.matched_text_preview : '';
    const normalizedPreview = preview.toUpperCase().replace(/\s+/g, ' ');

    return Response.json({
      ok: Boolean(syncResult.ok) && Boolean(ocrResult.ok) && Boolean(matched) && normalizedPreview.includes(EXPECTED_FRAGMENT),
      exact_sync_handler_ok: Boolean(syncResult.ok),
      drive_files_seen: Number(syncResult.drive_files || 0),
      newly_registered: Number(syncResult.newly_registered || 0),
      exact_ocr_handler_ok: Boolean(ocrResult.ok),
      ocr_char_count: Number(ocrResult.ocr_char_count || 0),
      exact_search_handler_ok: Boolean(matched),
      expected_fragment_found: normalizedPreview.includes(EXPECTED_FRAGMENT),
      ocr_preview: preview.slice(0, 160)
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
