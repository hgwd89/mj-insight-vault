import { createHash } from 'node:crypto';
import { organizeNeonSourceArticles } from '@/lib/neonArticleOrganization';
import {
  extractNeonCookieHeader,
  fetchNeonJwt,
  neonAuthFetch,
  neonDataFetch,
  parseUpstreamJson
} from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function deriveOwnerCredentials() {
  const appPassword = process.env.APP_PASSWORD || '';
  if (!appPassword) throw new Error('APP_PASSWORD is not configured.');
  const digest = createHash('sha256').update(`mj-neon-owner-v1:${appPassword}`, 'utf8').digest('hex');
  const password = `${createHash('sha256').update(`mj-neon-password-v1:${appPassword}`, 'utf8').digest('base64url')}Aa1!`;
  return {
    email: `mj-vault-${digest.slice(0, 20)}@example.com`,
    password,
    name: 'MJ Insight Vault Owner'
  };
}

async function ownerJwt() {
  const credentials = deriveOwnerCredentials();
  let upstream = await neonAuthFetch('/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: credentials.email, password: credentials.password, rememberMe: true })
  });
  if (!upstream.ok && [400, 401, 404].includes(upstream.status)) {
    upstream = await neonAuthFetch('/sign-up/email', {
      method: 'POST',
      body: JSON.stringify(credentials)
    });
  }
  await parseUpstreamJson(upstream, 'Neon Auth preview sign-in failed.');
  const cookieHeader = extractNeonCookieHeader(upstream.headers);
  if (!cookieHeader) throw new Error('Neon Auth returned no session cookie.');
  return fetchNeonJwt(cookieHeader);
}

async function pendingSources(jwt: string) {
  const sourceResponse = await neonDataFetch(
    'vault_source_files?ocr_status=eq.done&source_status=neq.e2e_test&select=id,file_name,mime_type&order=created_at.asc&limit=5000',
    jwt,
    { method: 'GET' }
  );
  const sourceJson = await parseUpstreamJson(sourceResponse, 'Could not load OCR-complete sources.');
  const sources = Array.isArray(sourceJson) ? sourceJson as Array<Record<string, unknown>> : [];

  const articleResponse = await neonDataFetch(
    'vault_articles?article_sequence=gt.0&select=source_file_id&limit=5000',
    jwt,
    { method: 'GET' }
  );
  const articleJson = await parseUpstreamJson(articleResponse, 'Could not load organized article sources.');
  const organized = new Set(
    (Array.isArray(articleJson) ? articleJson as Array<Record<string, unknown>> : [])
      .map((row) => clean(row.source_file_id, 100))
      .filter(Boolean)
  );

  return sources.filter((source) => {
    const id = clean(source.id, 100);
    const mime = clean(source.mime_type, 200).toLowerCase();
    return id && !organized.has(id) && ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
  });
}

export async function GET() {
  try {
    if (process.env.VERCEL_ENV === 'production') {
      return Response.json({ ok: false, error: 'Preview-only route.' }, { status: 404 });
    }

    const jwt = await ownerJwt();
    const before = await pendingSources(jwt);
    const target = before[0];
    if (!target) return Response.json({ ok: true, done: true, remaining: 0 });

    const sourceFileId = clean(target.id, 100);
    const result = await organizeNeonSourceArticles({ jwt, sourceFileId });
    const after = await pendingSources(jwt);

    return Response.json({
      ok: true,
      done: after.length === 0,
      source_file_id: sourceFileId,
      file_name: target.file_name,
      article_count: result.article_count,
      article_date: result.article_date,
      remaining: after.length
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
