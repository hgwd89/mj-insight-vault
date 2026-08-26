export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const upstream = await fetch(
    'https://wqbjtvepnavkqdshppau.supabase.co/functions/v1/ocr-v21-db-probe-20260826',
    { cache: 'no-store' }
  );
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' }
  });
}
