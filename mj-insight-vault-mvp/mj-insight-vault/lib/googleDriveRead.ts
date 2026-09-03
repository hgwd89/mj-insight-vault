import { createSign } from 'node:crypto';

type GoogleServiceAccount = {
  client_email?: string;
  private_key?: string;
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

function getCredentials(): Required<Pick<GoogleServiceAccount, 'client_email' | 'private_key'>> & GoogleServiceAccount {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS || '';
  let credentials: GoogleServiceAccount;
  try {
    credentials = JSON.parse(raw) as GoogleServiceAccount;
  } catch {
    throw new Error('Googleドライブ認証情報が不正です。');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Googleドライブ認証情報が設定されていません。');
  }
  return credentials as Required<Pick<GoogleServiceAccount, 'client_email' | 'private_key'>> & GoogleServiceAccount;
}

async function getDriveAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.accessToken;

  const credentials = getCredentials();
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
    .sign(credentials.private_key.replace(/\\n/g, '\n'));
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
  if (!response.ok) throw new Error(`Google認証に失敗しました（${response.status}）。`);
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Google認証トークンを取得できませんでした。');

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in || 3600)
  };
  return cachedToken.accessToken;
}

export async function downloadGoogleDriveFile(fileId: string) {
  const cleanId = fileId.trim();
  if (!cleanId) throw new Error('GoogleドライブのファイルIDがありません。');
  const token = await getDriveAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cleanId)}?alt=media&supportsAllDrives=true`,
    {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store'
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Googleドライブから原本を取得できませんでした（${response.status}）。${text.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
