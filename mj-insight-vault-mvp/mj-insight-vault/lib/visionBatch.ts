import { createSign } from 'node:crypto';

type GoogleServiceAccount = {
  project_id?: string;
  private_key?: string;
  client_email?: string;
  token_uri?: string;
};

export class VisionProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;
const TIMEOUT_MS = 90_000;
const MAX_BATCH = 16;

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function retryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
async function timedFetch(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new VisionProviderError('Google Vision request timed out.', true);
    if (error instanceof TypeError) throw new VisionProviderError(`Google Vision network failure: ${error.message}`, true);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function credentials(): GoogleServiceAccount {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_CLOUD_CREDENTIALS is not configured.');
  let value: GoogleServiceAccount;
  try { value = JSON.parse(raw) as GoogleServiceAccount; }
  catch { throw new Error('GOOGLE_CLOUD_CREDENTIALS is not valid JSON.'); }
  if (!value.project_id || !value.client_email || !value.private_key) throw new Error('GOOGLE_CLOUD_CREDENTIALS is missing project_id, client_email, or private_key.');
  return value;
}
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.accessToken;
  const c = credentials();
  const tokenUri = c.token_uri || 'https://oauth2.googleapis.com/token';
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, exp: now + 3600, iat: now }));
  const unsigned = `${header}.${claim}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(c.private_key!.replace(/\\n/g, '\n'));
  const jwt = `${unsigned}.${base64Url(signature)}`;
  const response = await timedFetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const raw = await response.text();
  if (!response.ok) throw new VisionProviderError(`Google OAuth token request failed: ${response.status} ${response.statusText} ${raw.slice(0, 1500)}`, retryableStatus(response.status));
  let json: { access_token?: string; expires_in?: number };
  try { json = JSON.parse(raw) as { access_token?: string; expires_in?: number }; }
  catch { throw new VisionProviderError('Google OAuth token response is not JSON.', true); }
  if (!json.access_token) throw new VisionProviderError('Google OAuth token response has no access_token.', true);
  cachedToken = { accessToken: json.access_token, expiresAt: now + (json.expires_in || 3600) };
  return cachedToken.accessToken;
}

export async function runDocumentOcrBatch(buffers: Buffer[]) {
  if (!Array.isArray(buffers) || buffers.length < 1 || buffers.length > MAX_BATCH) throw new Error(`Google crop OCR batch size must be between 1 and ${MAX_BATCH}.`);
  const token = await accessToken();
  const response = await timedFetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: buffers.map((buffer) => ({ image: { content: buffer.toString('base64') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: { languageHints: ['ja', 'en'] } })) })
  });
  const raw = await response.text();
  if (!response.ok) throw new VisionProviderError(`Google Vision API request failed: ${response.status} ${response.statusText} ${raw.slice(0, 1800)}`, retryableStatus(response.status));
  let json: { responses?: Array<Record<string, unknown>> };
  try { json = JSON.parse(raw) as { responses?: Array<Record<string, unknown>> }; }
  catch { throw new VisionProviderError('Google Vision API response is not JSON.', true); }
  if (!Array.isArray(json.responses) || json.responses.length !== buffers.length) throw new VisionProviderError('Google Vision API response count mismatch.', true);
  return json.responses.map((item, index) => {
    const error = item.error as { code?: number; status?: string; message?: string } | undefined;
    if (error) {
      const code = Number(error.code || 0);
      throw new VisionProviderError(`Google Vision API item error: index=${index} code=${code} status=${error.status || ''} message=${error.message || ''}`, retryableStatus(code));
    }
    const full = item.fullTextAnnotation as { text?: string } | undefined;
    const annotations = item.textAnnotations as Array<{ description?: string }> | undefined;
    return { text: String(full?.text || annotations?.[0]?.description || '').trim(), raw: item };
  });
}
