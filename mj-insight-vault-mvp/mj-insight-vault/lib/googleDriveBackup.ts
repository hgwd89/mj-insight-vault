import { createSign } from 'node:crypto';

type GoogleServiceAccount = {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  token_uri?: string;
};

export type DriveBackupResult = {
  ok: boolean;
  skipped?: boolean;
  file_id?: string;
  web_view_link?: string;
  folder_id?: string;
  error?: string;
};

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function base64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseCredentials(): GoogleServiceAccount | null {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS;
  if (!raw) return null;

  try {
    return JSON.parse(raw) as GoogleServiceAccount;
  } catch {
    return null;
  }
}

function getCredentials(): GoogleServiceAccount {
  const credentials = parseCredentials();
  if (!credentials) throw new Error('GOOGLE_CLOUD_CREDENTIALS is not configured or is invalid JSON.');
  if (!credentials.client_email) throw new Error('GOOGLE_CLOUD_CREDENTIALS is missing client_email.');
  if (!credentials.private_key) throw new Error('GOOGLE_CLOUD_CREDENTIALS is missing private_key.');
  return credentials;
}

async function getDriveAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.accessToken;

  const credentials = getCredentials();
  const privateKey = credentials.private_key!.replace(/\\n/g, '\n');
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';

  const unsignedJwt = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;

  const signature = createSign('RSA-SHA256').update(unsignedJwt).sign(privateKey);
  const jwt = `${unsignedJwt}.${base64Url(signature)}`;

  const tokenRes = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });

  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Google OAuth token request failed: ${tokenRes.status} ${tokenText}`);

  const tokenJson = JSON.parse(tokenText) as { access_token?: string; expires_in?: number };
  if (!tokenJson.access_token) throw new Error(`Google OAuth token response has no access_token: ${tokenText}`);

  cachedToken = { accessToken: tokenJson.access_token, expiresAt: now + (tokenJson.expires_in || 3600) };
  return cachedToken.accessToken;
}

export function getGoogleDriveBackupConfig() {
  const credentials = parseCredentials();
  const folderId = (process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  const enabled = (process.env.GOOGLE_DRIVE_BACKUP_ENABLED || '').trim().toLowerCase();

  return {
    enabled: enabled === 'true' || enabled === '1' || Boolean(folderId),
    folderId,
    hasCredentials: Boolean(credentials?.client_email && credentials?.private_key),
    clientEmail: credentials?.client_email || ''
  };
}

export async function backupImageToGoogleDrive(args: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  batchId: string;
  index: number;
  folderId?: string;
  description?: string;
}): Promise<DriveBackupResult> {
  const config = getGoogleDriveBackupConfig();
  const folderId = (args.folderId || config.folderId || '').trim();

  if (!args.folderId && !config.enabled) return { ok: true, skipped: true };
  if (!folderId) return { ok: false, error: 'Google Drive destination folder is not configured.' };
  if (!config.hasCredentials) return { ok: false, error: 'GOOGLE_CLOUD_CREDENTIALS is not configured.' };

  try {
    const accessToken = await getDriveAccessToken();
    const boundary = `mj-vault-${crypto.randomUUID()}`;
    const metadata = {
      name: args.fileName,
      parents: [folderId],
      description: args.description || `MJ Insight Vault original. batch_id=${args.batchId}; index=${args.index}`,
      appProperties: {
        source: 'mj-insight-vault',
        batch_id: args.batchId,
        index: String(args.index)
      }
    };

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-type: ${args.mimeType}\r\n\r\n`),
      args.buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': `multipart/related; boundary=${boundary}`,
        'content-length': String(body.length)
      },
      body
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, folder_id: folderId, error: `Google Drive upload failed: ${res.status} ${text}` };

    const json = JSON.parse(text) as { id?: string; webViewLink?: string };
    return { ok: true, file_id: json.id, web_view_link: json.webViewLink, folder_id: folderId };
  } catch (error) {
    return { ok: false, folder_id: folderId, error: error instanceof Error ? error.message : 'Google Drive upload failed' };
  }
}
