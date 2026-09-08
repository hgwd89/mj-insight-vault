import { createSign } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getOwnerNeonJwt, pendingOrganizeSourceIds } from '@/lib/cloudStockBackgroundOcr';
import { neonDataFetch, parseUpstreamJson } from '@/lib/neonCloud';
import { downloadGoogleDriveFile } from '@/lib/googleDriveRead';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function cloudPlatformToken(credentials: {
  client_email: string;
  private_key: string;
  token_uri?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(credentials.private_key.replace(/\\n/g, '\n'));
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64Url(signature)}`
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google OAuth ${response.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error('Google OAuth token missing');
  return json.access_token;
}

const responseSchema = {
  type: 'OBJECT',
  properties: {
    articles: {
      type: 'ARRAY',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'OBJECT',
        properties: {
          headline: { type: 'STRING' },
          subheadline: { type: 'STRING' },
          article_date: { type: 'STRING' },
          article_type: { type: 'STRING', enum: ['article', 'table', 'chart', 'caption', 'unknown'] },
          body_reconstructed: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          has_table: { type: 'BOOLEAN' },
          has_chart: { type: 'BOOLEAN' },
          has_image: { type: 'BOOLEAN' }
        },
        required: [
          'headline',
          'subheadline',
          'article_date',
          'article_type',
          'body_reconstructed',
          'confidence',
          'has_table',
          'has_chart',
          'has_image'
        ]
      }
    }
  },
  required: ['articles']
};

export async function GET(req: NextRequest) {
  try {
    const jwt = await getOwnerNeonJwt();
    const pending = await pendingOrganizeSourceIds(jwt);
    const requested = Number(req.nextUrl.searchParams.get('i') || '0');
    const index = Number.isFinite(requested)
      ? Math.max(0, Math.min(Math.floor(requested), Math.max(0, pending.length - 1)))
      : 0;
    const sourceFileId = pending[index];
    if (!sourceFileId) return Response.json({ ok: true, pending: 0, message: '整理待ちはありません。' });

    const sourceRes = await neonDataFetch(
      `vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}&select=id,drive_file_id,file_name,mime_type&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const sourceJson = await parseUpstreamJson(sourceRes, 'source load failed');
    const source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
    if (!source) throw new Error('source missing');

    const pageRes = await neonDataFetch(
      `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=eq.0&select=ocr_text_raw,ocr_text_verified&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const pageJson = await parseUpstreamJson(pageRes, 'OCR load failed');
    const page = Array.isArray(pageJson) ? pageJson[0] as Record<string, unknown> | undefined : undefined;
    const ocr = clean(page?.ocr_text_verified, 100000) || clean(page?.ocr_text_raw, 100000);
    if (!ocr) throw new Error('OCR missing');

    const mimeType = clean(source.mime_type, 100) || 'image/png';
    const image = await downloadGoogleDriveFile(clean(source.drive_file_id, 256));
    const credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS || '') as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!credentials.project_id || !credentials.client_email || !credentials.private_key) throw new Error('Google credentials incomplete');
    const token = await cloudPlatformToken(credentials as { client_email: string; private_key: string; token_uri?: string });

    const prompt = [
      '日経MJ紙面を検索用ニュースDBの記事単位に整理してください。画像を主情報、OCRを補助に使います。',
      'articlesには独立した編集記事だけを入れてください。広告・購読案内・イベント告知だけの枠・商品カタログは除外してください。',
      '最重要: 図表・ランキング表・グラフ・写真キャプションは、それ自体を独立記事にしないでください。対応する本文記事へ内容を統合し、has_table / has_chart / has_imageで示してください。紙面全体が図表だけで本文記事が無い場合に限り、tableまたはchartとして1件にしてください。',
      '別見出しと独立した本文枠がある場合だけ複数記事に分け、同一記事を細切れにしないでください。記事数は必要最小限にしてください。',
      '見出し、掲載日、企業名、サービス名、人物名、数字など検索・再分析に必要な事実を本文へ保持してください。',
      '記事にない解釈・評価・示唆は追加しないでください。原文の情報量を超えて水増ししないでください。',
      'article_dateは確実な場合のみYYYY-MM-DD、不明なら空文字。',
      '',
      'Google Vision OCR（段組み崩れ・広告混入あり）:',
      ocr.slice(0, 8000)
    ].join('\n');

    const model = 'gemini-2.5-flash';
    const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(credentials.project_id)}/locations/global/publishers/google/models/${model}:generateContent`;
    const vertexRes = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: image.toString('base64') } }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });
    const vertexText = await vertexRes.text();
    if (!vertexRes.ok) return Response.json({ ok: false, status: vertexRes.status, error: vertexText.slice(0, 2500) }, { status: 502 });

    const vertexJson = JSON.parse(vertexText) as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: unknown;
      modelVersion?: string;
    };
    const candidate = vertexJson.candidates?.[0];
    const output = candidate?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
    let parsed: { articles?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(output) as { articles?: Array<Record<string, unknown>> };
    } catch (error) {
      return Response.json({
        ok: false,
        parse_error: error instanceof Error ? error.message : String(error),
        finish_reason: candidate?.finishReason || null,
        output_chars: output.length,
        output_tail: output.slice(-600),
        usage: vertexJson.usageMetadata || null
      }, { status: 502 });
    }
    const articles = Array.isArray(parsed.articles) ? parsed.articles : [];

    return Response.json({
      ok: true,
      index,
      model_version: vertexJson.modelVersion || model,
      source_file_id: sourceFileId,
      file_name: source.file_name,
      pending_count: pending.length,
      finish_reason: candidate?.finishReason || null,
      article_count: articles.length,
      articles: articles.map((a) => ({
        headline: a.headline,
        subheadline: a.subheadline,
        article_date: a.article_date,
        article_type: a.article_type,
        body_chars: typeof a.body_reconstructed === 'string' ? a.body_reconstructed.length : 0,
        body_preview: typeof a.body_reconstructed === 'string' ? a.body_reconstructed.slice(0, 500) : '',
        confidence: a.confidence,
        has_table: a.has_table,
        has_chart: a.has_chart,
        has_image: a.has_image
      })),
      usage: vertexJson.usageMetadata || null
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
