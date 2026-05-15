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
  const message = error instanceof Error ? error.message : 'Unknown error';
  const maybeStatus = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
  return Response.json({ error: message }, { status: maybeStatus || status });
}
