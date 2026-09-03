import { createSign } from 'node:crypto';

type GoogleServiceAccount = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

export type GoogleDriveListedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
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

export async function listGoogleDriveFolderFiles(folderId: string, limit = 1000) {
  const cleanFolderId = folderId.trim();
  if (!cleanFolderId) throw new Error('GoogleドライブのフォルダIDがありません。');
  const token = await getDriveAccessToken();
  const params = new URLSearchParams({
    q: `'${cleanFolderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    pageSize: String(Math.max(1, Math.min(limit, 1000))),
    fields: 'files(id,name,mimeType,size)',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true'
  });
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Googleドライブの資料一覧を取得できませんでした（${response.status}）。`);
  const json = JSON.parse(text) as { files?: Array<{ id?: string; name?: string; mimeType?: string; size?: string }> };
  return (json.files || [])
    .filter((file) => file.id && file.name && file.mimeType !== 'application/vnd.google-apps.folder')
    .map((file): GoogleDriveListedFile => ({
      id: String(file.id),
      name: String(file.name),
      mimeType: String(file.mimeType || ''),
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : null
    }));
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

export async function probeGoogleDriveFolderRead(folderId: string) {
  try {
    const files = await listGoogleDriveFolderFiles(folderId, 1000);
    if (files.length === 0) {
      return { ok: true, fileCount: 0, firstFileReadable: null as boolean | null, error: null as string | null };
    }
    const token = await getDriveAccessToken();
    const first = files[0];
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(first.id)}?alt=media&supportsAllDrives=true`,
      {
        headers: { authorization: `Bearer ${token}`, range: 'bytes=0-15' },
        cache: 'no-store'
      }
    );
    if (!response.ok && response.status !== 206) {
      return {
        ok: false,
        fileCount: files.length,
        firstFileReadable: false,
        error: `Googleドライブ原本の読取確認に失敗しました（${response.status}）。`
      };
    }
    await response.arrayBuffer();
    return { ok: true, fileCount: files.length, firstFileReadable: true, error: null as string | null };
  } catch (error) {
    return {
      ok: false,
      fileCount: 0,
      firstFileReadable: false,
      error: error instanceof Error ? error.message : 'Googleドライブ原本の読取確認に失敗しました。'
    };
  }
}
