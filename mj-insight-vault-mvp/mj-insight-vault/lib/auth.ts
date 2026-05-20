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

function errorRecord(error: unknown) {
  return error && typeof error === 'object' && !Array.isArray(error) ? error as Record<string, unknown> : null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;

  const record = errorRecord(error);
  const message = typeof record?.message === 'string' ? record.message : '';
  const details = typeof record?.details === 'string' ? record.details : '';
  const hint = typeof record?.hint === 'string' ? record.hint : '';
  const code = typeof record?.code === 'string' ? record.code : '';

  const lower = `${message} ${details} ${hint}`.toLowerCase();
  if (code === '42P01' || lower.includes('chat_jobs') || lower.includes('relation') && lower.includes('does not exist')) {
    return 'chat_jobsテーブルが未作成です。Supabaseで supabase/migrations/20260519_create_chat_jobs.sql を適用してください。';
  }

  return [message, details, hint, code ? `code: ${code}` : ''].filter(Boolean).join(' / ') || 'Unknown error';
}

export function jsonError(error: unknown, status = 500) {
  const message = errorMessage(error);
  const record = errorRecord(error);
  const maybeStatus = error instanceof Error
    ? (error as Error & { status?: number }).status
    : typeof record?.status === 'number'
      ? record.status
      : undefined;
  return Response.json({ error: message }, { status: maybeStatus || status });
}
