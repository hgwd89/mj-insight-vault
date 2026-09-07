import { createSign } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function cloudPlatformToken(credentials: { client_email: string; private_key: string; token_uri?: string }) {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key.replace(/\\n/g, '\n'));
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google OAuth ${response.status}: ${text.slice(0, 800)}`);
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error('Google OAuth access token missing');
  return json.access_token;
}

export async function GET() {
  try {
    const raw = process.env.GOOGLE_CLOUD_CREDENTIALS || '';
    const credentials = JSON.parse(raw) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!credentials.project_id || !credentials.client_email || !credentials.private_key) {
      throw new Error('GOOGLE_CLOUD_CREDENTIALS lacks project_id/client_email/private_key');
    }
    const token = await cloudPlatformToken(credentials as { client_email: string; private_key: string; token_uri?: string });
    const model = 'gemini-2.5-flash';
    const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(credentials.project_id)}/locations/global/publishers/google/models/${model}:generateContent`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Return exactly this JSON and nothing else: {"ok":true,"purpose":"mj-article-canary"}' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 80, responseMimeType: 'application/json' }
      })
    });
    const text = await response.text();
    return Response.json({
      ok: response.ok,
      status: response.status,
      model,
      project_id: credentials.project_id,
      body: text.slice(0, 3000)
    }, { status: response.ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
