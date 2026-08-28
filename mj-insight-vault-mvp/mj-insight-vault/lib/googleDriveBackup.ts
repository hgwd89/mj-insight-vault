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

export type DriveFolderProbe = {
  ok: boolean;
  folderId: string;
  name?: string;
  canAddChildren?: boolean;
  error?: string;
};

let cachedToken: { accessToken: string; expiresAt: number } | null = null;
let cachedWritableFolder: { folderId: string; expiresAt: number } | null = null;

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
    scope: 'https://www.googleapis.com/auth/drive',
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

export async function inspectGoogleDriveFolder(folderId: string): Promise<DriveFolderProbe> {
  const cleanId = folderId.trim();
  if (!cleanId) return { ok: false, folderId: '', error: 'Drive folder ID is empty.' };

  const config = getGoogleDriveBackupConfig();
  if (!config.hasCredentials) return { ok: false, folderId: cleanId, error: 'GOOGLE_CLOUD_CREDENTIALS is not configured.' };

  try {
    const accessToken = await getDriveAccessToken();
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cleanId)}?fields=id,name,mimeType,capabilities(canAddChildren)&supportsAllDrives=true`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store'
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, folderId: cleanId, error: `Drive folder probe failed: ${response.status} ${text}` };
    const json = JSON.parse(text) as { id?: string; name?: string; mimeType?: string; capabilities?: { canAddChildren?: boolean } };
    const isFolder = json.mimeType === 'application/vnd.google-apps.folder';
    const canAddChildren = Boolean(json.capabilities?.canAddChildren);
    return {
      ok: isFolder && canAddChildren,
      folderId: json.id || cleanId,
      name: json.name,
      canAddChildren,
      error: isFolder && canAddChildren ? undefined : 'Service account can read the item but cannot add children.'
    };
  } catch (error) {
    return { ok: false, folderId: cleanId, error: error instanceof Error ? error.message : 'Drive folder probe failed.' };
  }
}

export async function resolveWritableGoogleDriveFolder(preferredFolderId: string) {
  const now = Date.now();
  if (cachedWritableFolder && cachedWritableFolder.expiresAt > now) {
    return { ok: true, folderId: cachedWritableFolder.folderId, cached: true } as const;
  }

  const config = getGoogleDriveBackupConfig();
  const candidates = Array.from(new Set([preferredFolderId.trim(), config.folderId.trim()].filter(Boolean)));
  const failures: DriveFolderProbe[] = [];

  for (const folderId of candidates) {
    const probe = await inspectGoogleDriveFolder(folderId);
    if (probe.ok) {
      cachedWritableFolder = { folderId: probe.folderId, expiresAt: now + 5 * 60_000 };
      return { ok: true, folderId: probe.folderId, probe, cached: false } as const;
    }
    failures.push(probe);
  }

  return {
    ok: false,
    folderId: '',
    failures,
    serviceAccountEmail: config.clientEmail,
    error: failures.map((failure) => `${failure.folderId}: ${failure.error || 'not writable'}`).join(' / ') || 'No writable Google Drive folder is configured.'
  } as const;
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
