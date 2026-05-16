import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL, VISION_MODEL, EMBEDDING_MODEL } from '@/lib/openai';

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

function envCheck(name: string, value: string | undefined): Check {
  const trimmed = value?.trim() || '';
  return {
    name,
    ok: Boolean(trimmed),
    detail: trimmed ? '設定済み' : '未設定'
  };
}

function googleCredentialsCheck(): Check {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS;

  if (!raw?.trim()) {
    return { name: 'GOOGLE_CLOUD_CREDENTIALS', ok: false, detail: '未設定' };
  }

  try {
    const parsed = JSON.parse(raw) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };

    const missing = ['project_id', 'client_email', 'private_key'].filter((key) => !parsed[key as keyof typeof parsed]);

    if (missing.length) {
      return {
        name: 'GOOGLE_CLOUD_CREDENTIALS',
        ok: false,
        detail: `JSONは読めますが不足項目があります: ${missing.join(', ')}`
      };
    }

    return {
      name: 'GOOGLE_CLOUD_CREDENTIALS',
      ok: true,
      detail: `設定済み: ${parsed.client_email}`
    };
  } catch {
    return {
      name: 'GOOGLE_CLOUD_CREDENTIALS',
      ok: false,
      detail: 'JSONとして読めません。Vercel環境変数にJSON全文が正しく入っているか確認してください。'
    };
  }
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);

    const checks: Check[] = [
      envCheck('APP_PASSWORD', process.env.APP_PASSWORD),
      envCheck('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
      envCheck('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
      envCheck('OPENAI_API_KEY', getOpenAIKey()),
      googleCredentialsCheck(),
      {
        name: 'STORAGE_BUCKET',
        ok: Boolean(STORAGE_BUCKET),
        detail: STORAGE_BUCKET || '未設定'
      },
      {
        name: 'OPENAI_TEXT_MODEL',
        ok: Boolean(TEXT_MODEL),
        detail: TEXT_MODEL
      },
      {
        name: 'OPENAI_VISION_MODEL',
        ok: Boolean(VISION_MODEL),
        detail: VISION_MODEL
      },
      {
        name: 'OPENAI_EMBEDDING_MODEL',
        ok: Boolean(EMBEDDING_MODEL),
        detail: EMBEDDING_MODEL
      }
    ];

    try {
      const { error } = await supabaseAdmin.from('articles').select('id').limit(1);
      checks.push({
        name: 'Supabase DB',
        ok: !error,
        detail: error ? error.message : 'articlesテーブルに接続できます'
      });
    } catch (error) {
      checks.push({
        name: 'Supabase DB',
        ok: false,
        detail: error instanceof Error ? error.message : '接続失敗'
      });
    }

    try {
      const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).list('', { limit: 1 });
      checks.push({
        name: 'Supabase Storage',
        ok: !error,
        detail: error ? error.message : `bucket ${STORAGE_BUCKET} に接続できます。root items: ${data?.length ?? 0}`
      });
    } catch (error) {
      checks.push({
        name: 'Supabase Storage',
        ok: false,
        detail: error instanceof Error ? error.message : '接続失敗'
      });
    }

    const ok = checks.every((check) => check.ok);

    return Response.json({ ok, checks });
  } catch (error) {
    return jsonError(error);
  }
}
