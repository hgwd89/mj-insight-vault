export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const isExpectedPreview = process.env.VERCEL_ENV === 'preview'
    && process.env.VERCEL_GIT_COMMIT_REF === 'audit/verified-pipeline-v10-buildcheck';
  if (!isExpectedPreview) return new Response('Not Found', { status: 404 });
  return Response.json({
    preview: true,
    openai: Boolean(process.env.OPENAI_API_KEY),
    google_cloud_credentials: Boolean(process.env.GOOGLE_CLOUD_CREDENTIALS),
    supabase_url: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabase_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    app_password: Boolean(process.env.APP_PASSWORD),
    storage_bucket: Boolean(process.env.SUPABASE_STORAGE_BUCKET || 'mj-images')
  }, { headers: { 'cache-control': 'no-store' } });
}
