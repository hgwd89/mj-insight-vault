import { createHash, createSign } from 'node:crypto';

type GoogleServiceAccount = {
  private_key?: string;
  client_email?: string;
  token_uri?: string;
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
  const credentials = JSON.parse(raw) as GoogleServiceAccount;
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is incomplete.');
  }
  return credentials;
}

async function getDriveAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.accessToken;

  const credentials = getCredentials();
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const privateKey = credentials.private_key!.replace(/\\n/g, '\n');
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
  if (!tokenJson.access_token) throw new Error('Google OAuth token response has no access_token.');

  cachedToken = { accessToken: tokenJson.access_token, expiresAt: now + (tokenJson.expires_in || 3600) };
  return cachedToken.accessToken;
}

export async function hashGoogleDriveFile(fileId: string) {
  const cleanId = fileId.trim();
  if (!cleanId) throw new Error('Google Drive file ID is empty.');
  const accessToken = await getDriveAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cleanId)}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store'
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Drive verification download failed: ${response.status} ${text}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
    mimeType: response.headers.get('content-type') || null
  };
}
