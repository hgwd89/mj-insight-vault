import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import {
  clearNeonSessionCookie,
  extractNeonCookieHeader,
  fetchNeonJwt,
  getNeonSessionCookie,
  neonAuthFetch,
  parseUpstreamJson,
  setNeonSessionCookie
} from '@/lib/neonCloud';

export const runtime = 'nodejs';

function cleanString(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await fetchNeonJwt(getNeonSessionCookie(req));
    return Response.json({ ok: true, token_ready: Boolean(jwt) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = cleanString(body.action, 32);
    const email = cleanString(body.email, 320).toLowerCase();
    const password = cleanString(body.password, 256);
    const name = cleanString(body.name, 120) || 'MJ Insight Vault';

    if (!email || !password) {
      return Response.json({ error: 'メールアドレスとパスワードが必要です。' }, { status: 400 });
    }
    if (action !== 'sign-in' && action !== 'sign-up') {
      return Response.json({ error: 'action must be sign-in or sign-up' }, { status: 400 });
    }

    const upstream = await neonAuthFetch(action === 'sign-up' ? '/sign-up/email' : '/sign-in/email', {
      method: 'POST',
      body: JSON.stringify(action === 'sign-up'
        ? { name, email, password }
        : { email, password, rememberMe: true })
    });

    const payload = await parseUpstreamJson(upstream, 'Neon Authに接続できませんでした。');
    const cookieHeader = extractNeonCookieHeader(upstream.headers);
    if (!cookieHeader) throw new Error('Neon Auth session cookie was not returned.');

    await fetchNeonJwt(cookieHeader);
    const response = Response.json({
      ok: true,
      action,
      user: payload && typeof payload === 'object' && 'user' in payload ? (payload as { user?: unknown }).user : null
    });
    return setNeonSessionCookie(response, cookieHeader);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    requireAppPassword(req);
    let cookieHeader = '';
    try {
      cookieHeader = getNeonSessionCookie(req);
    } catch {
      // Clearing a missing/expired local proxy session is still a valid sign-out.
    }

    if (cookieHeader) {
      await neonAuthFetch('/sign-out', { method: 'POST', headers: { cookie: cookieHeader } }).catch(() => null);
    }

    return clearNeonSessionCookie(Response.json({ ok: true }));
  } catch (error) {
    return jsonError(error);
  }
}
