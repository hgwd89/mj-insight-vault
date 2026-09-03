import { createSign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import {
  GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
  neonDataFetch,
  parseUpstreamJson,
  requireNeonJwt
} from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ServiceAccount = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
};

function base64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getCredentials(): ServiceAccount {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS || '';
  const credentials = JSON.parse(raw) as ServiceAccount;
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google Drive credentials are not configured.');
  }
  return credentials;
}

async function getDriveToken() {
  const credentials = getCredentials();
  const privateKey = credentials.private_key!;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey.replace(/\\n/g, '\n'));
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google OAuth failed: ${response.status} ${text}`);
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error('Google OAuth returned no access token.');
  return json.access_token;
}

async function listOriginals() {
  const token = await getDriveToken();
  const files: DriveFile[] = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      q: `'${GOOGLE_DRIVE_ORIGINALS_FOLDER_ID}' in parents and trashed = false`,
      pageSize: '1000',
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Drive list failed: ${response.status} ${text}`);
    const json = JSON.parse(text) as { files?: DriveFile[]; nextPageToken?: string };
    files.push(...(json.files || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken && files.length < 5000);

  return files.filter((file) => file.id && file.name && file.mimeType !== 'application/vnd.google-apps.folder');
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const driveFiles = await listOriginals();

    const existingResponse = await neonDataFetch('vault_source_files?select=drive_file_id&limit=5000', jwt, {
      method: 'GET'
    });
    const existingJson = await parseUpstreamJson(existingResponse, 'Neonの既存ファイル確認に失敗しました。');
    const existingIds = new Set(
      (Array.isArray(existingJson) ? existingJson : [])
        .map((row) => row && typeof row === 'object' && 'drive_file_id' in row ? String((row as { drive_file_id?: unknown }).drive_file_id || '') : '')
        .filter(Boolean)
    );

    const newFiles = driveFiles.filter((file) => file.id && !existingIds.has(file.id));
    if (newFiles.length) {
      const rows = newFiles.map((file) => ({
        drive_file_id: file.id,
        drive_folder_id: GOOGLE_DRIVE_ORIGINALS_FOLDER_ID,
        file_name: file.name,
        mime_type: file.mimeType || null,
        file_size_bytes: file.size && Number.isFinite(Number(file.size)) ? Number(file.size) : null,
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
      await parseUpstreamJson(insertResponse, 'Google DriveからNeonへの同期に失敗しました。');
    }

    return Response.json({
      ok: true,
      drive_files: driveFiles.length,
      already_registered: driveFiles.length - newFiles.length,
      newly_registered: newFiles.length,
      new_file_names: newFiles.slice(0, 20).map((file) => file.name),
      downstream_started: false
    });
  } catch (error) {
    return jsonError(error);
  }
}
