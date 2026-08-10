import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({
    openaiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY?.trim()),
    supabaseServiceRolePresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    supabaseUrlPresent: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()),
    appPasswordPresent: Boolean(process.env.APP_PASSWORD?.trim()),
    openaiTextModel: process.env.OPENAI_TEXT_MODEL || null,
  });
}
