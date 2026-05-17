import { createSign } from 'node:crypto';

type GoogleServiceAccount = {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  token_uri?: string;
};

type DriveBackupResult = {
  ok: boolean;
  skipped?: boolean;
  file_id?: string;
  web_view_link?: string;
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

function getCredentials(): GoogleServiceAccount {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_CLOUD_CREDENTIALS is not configured.');

  let credentials: GoogleServiceAccount;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not valid JSON.');
  }

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
  const folderId = (process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  const enabled = (process.env.GOOGLE_DRIVE_BACKUP_ENABLED || '').trim().toLowerCase();
  const hasCredentials = Boolean(process.env.GOOGLE_CLOUD_CREDENTIALS?.trim());

  return {
    enabled: enabled === 'true' || enabled === '1' || Boolean(folderId),
    folderId,
    hasCredentials
  };
}

export async function backupImageToGoogleDrive(args: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  batchId: string;
  index: number;
}): Promise<DriveBackupResult> {
  const config = getGoogleDriveBackupConfig();

  if (!config.enabled) return { ok: true, skipped: true };
  if (!config.folderId) return { ok: false, error: 'GOOGLE_DRIVE_BACKUP_FOLDER_ID is not configured.' };
  if (!config.hasCredentials) return { ok: false, error: 'GOOGLE_CLOUD_CREDENTIALS is not configured.' };

  try {
    const accessToken = await getDriveAccessToken();
    const boundary = `mj-vault-${crypto.randomUUID()}`;
    const metadata = {
      name: args.fileName,
      parents: [config.folderId],
      description: `MJ Insight Vault backup. batch_id=${args.batchId}; index=${args.index}`,
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
    if (!res.ok) return { ok: false, error: `Google Drive upload failed: ${res.status} ${text}` };

    const json = JSON.parse(text) as { id?: string; webViewLink?: string };
    return { ok: true, file_id: json.id, web_view_link: json.webViewLink };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Google Drive upload failed' };
  }
}
