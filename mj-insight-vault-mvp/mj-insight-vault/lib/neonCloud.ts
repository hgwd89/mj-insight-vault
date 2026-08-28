import { NextRequest } from 'next/server';

export const NEON_AUTH_URL = 'https://ep-wandering-moon-axn8atye.neonauth.c-4.us-east-2.aws.neon.tech/neondb/auth';
export const NEON_DATA_API_URL = 'https://ep-wandering-moon-axn8atye.apirest.c-4.us-east-2.aws.neon.tech/neondb/rest/v1';
export const GOOGLE_DRIVE_ORIGINALS_FOLDER_ID = '1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';
export const GOOGLE_DRIVE_EXPORTS_FOLDER_ID = '1FZNZaPO9MTC147yNzinSY_bGvyFTUfnG';

const SESSION_COOKIE = 'mj_neon_session';
const MAX_SESSION_COOKIE_BYTES = 12_000;

type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

function errorWithStatus(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function extractSetCookieValues(headers: Headers) {
  const values = (headers as HeadersWithSetCookie).getSetCookie?.() || [];
  if (values.length) return values;
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function extractNeonCookieHeader(headers: Headers) {
  return extractSetCookieValues(headers)
    .map((value) => value.split(';', 1)[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function encodeSessionCookie(cookieHeader: string) {
  return Buffer.from(cookieHeader, 'utf8').toString('base64url');
}

function decodeSessionCookie(encoded: string) {
  try {
    const value = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!value || value.length > MAX_SESSION_COOKIE_BYTES || /[\r\n]/.test(value)) return '';
    return value;
  } catch {
    return '';
  }
}

export function setNeonSessionCookie(response: Response, cookieHeader: string) {
  const encoded = encodeSessionCookie(cookieHeader);
  response.headers.append(
    'set-cookie',
    `${SESSION_COOKIE}=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  );
  return response;
}

export function clearNeonSessionCookie(response: Response) {
  response.headers.append(
    'set-cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  return response;
}

export function getNeonSessionCookie(req: NextRequest) {
  const encoded = req.cookies.get(SESSION_COOKIE)?.value || '';
  const cookieHeader = decodeSessionCookie(encoded);
  if (!cookieHeader) throw errorWithStatus('Neonへログインしてください。', 401);
  return cookieHeader;
}

export async function neonAuthFetch(path: string, init: RequestInit = {}) {
  return fetch(`${NEON_AUTH_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
}

export async function fetchNeonJwt(cookieHeader: string) {
  const headers = { cookie: cookieHeader, accept: 'application/json' };

  const tokenResponse = await neonAuthFetch('/token', { method: 'GET', headers });
  if (tokenResponse.ok) {
    const tokenJson = await tokenResponse.json().catch(() => null) as { token?: string } | null;
    if (tokenJson?.token) return tokenJson.token;
  }

  const sessionResponse = await neonAuthFetch('/get-session', { method: 'GET', headers });
  if (sessionResponse.ok) {
    const headerToken = sessionResponse.headers.get('set-auth-jwt');
    if (headerToken) return headerToken;
  }

  throw errorWithStatus('Neonセッションの有効期限が切れています。再ログインしてください。', 401);
}

export async function requireNeonJwt(req: NextRequest) {
  return fetchNeonJwt(getNeonSessionCookie(req));
}

export async function neonDataFetch(path: string, jwt: string, init: RequestInit = {}) {
  if (!jwt || jwt.length > 16_000) throw errorWithStatus('Neon JWTが不正です。', 401);

  return fetch(`${NEON_DATA_API_URL}/${path.replace(/^\//, '')}`, {
    ...init,
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
}

export async function parseUpstreamJson(response: Response, fallback: string) {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = json && typeof json === 'object' && 'message' in json && typeof (json as { message?: unknown }).message === 'string'
      ? String((json as { message: string }).message)
      : json && typeof json === 'object' && 'error' in json && typeof (json as { error?: unknown }).error === 'string'
        ? String((json as { error: string }).error)
        : text || fallback;
    throw errorWithStatus(message, response.status >= 400 && response.status < 600 ? response.status : 502);
  }

  return json;
}
