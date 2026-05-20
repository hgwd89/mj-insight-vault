import { NextRequest } from 'next/server';

export function requireAppPassword(req: NextRequest) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) throw new Error('APP_PASSWORD is not configured.');
  const provided = req.headers.get('x-app-password') || '';
  if (provided !== expected) {
    const err = new Error('Unauthorized');
    (err as Error & { status?: number }).status = 401;
    throw err;
  }
}

export function jsonError(error: unknown, status = 500) {
  const rawMessage = error instanceof Error ? error.message : 'Unknown error';
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = (code === '42P01' || /relation .*chat_jobs.* does not exist/i.test(rawMessage))
    ? 'chat_jobs テーブルがありません。Supabase migration 20260519_create_chat_jobs.sql を適用してください。'
    : rawMessage;
  const maybeStatus = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
  return Response.json({ error: message }, { status: maybeStatus || status });
}
