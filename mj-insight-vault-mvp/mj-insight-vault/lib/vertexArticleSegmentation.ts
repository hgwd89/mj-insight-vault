import { createSign } from 'node:crypto';
import { z } from 'zod';
import { firstLikelyHeadline, normalizeOcrText } from '@/lib/text';

export type VertexArticleCandidate = {
  headline: string;
  article_date?: string | null;
  ocr_text: string;
  article_type: 'article' | 'table' | 'chart' | 'caption' | 'unknown';
  has_table: boolean;
  has_chart: boolean;
  has_image: boolean;
};

type SegmentInput = {
  ocrText: string;
  imageBuffer: Buffer;
  mimeType: string;
};

type GoogleCredentials = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

const VertexArticleListSchema = z.object({
  articles: z.array(z.object({
    headline: z.string(),
    subheadline: z.string(),
    article_date: z.string(),
    article_type: z.enum(['article', 'table', 'chart', 'caption', 'unknown']),
    body_reconstructed: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    has_table: z.boolean(),
    has_chart: z.boolean(),
    has_image: z.boolean()
  })).min(1).max(4)
});

const RESPONSE_SCHEMA = {
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
          article_type: {
            type: 'STRING',
            enum: ['article', 'table', 'chart', 'caption', 'unknown']
          },
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

function base64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function validDate(value: string) {
  const text = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function credentialsFromEnv(): Required<Pick<GoogleCredentials, 'project_id' | 'client_email' | 'private_key'>> & Pick<GoogleCredentials, 'token_uri'> {
  let parsed: GoogleCredentials;
  try {
    parsed = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS || '') as GoogleCredentials;
  } catch {
    throw new Error('Vertex article organization: GOOGLE_CLOUD_CREDENTIALS is invalid JSON.');
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('Vertex article organization: Google credentials are incomplete.');
  }
  return {
    project_id: parsed.project_id,
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri
  };
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
  if (!response.ok) {
    throw new Error(`Vertex article organization: Google OAuth ${response.status}: ${text.slice(0, 600)}`);
  }
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error('Vertex article organization: Google OAuth token missing.');
  return json.access_token;
}

function articlePrompt(ocrText: string) {
  return [
    '日経MJ紙面を、後から検索・Inventory・Reportで再利用できるニュースDBの記事単位に整理してください。画像を主情報、Google Vision OCRを補助情報として使います。',
    'articlesには独立した編集記事だけを入れてください。広告、純広告、タイアップ広告、購読案内、イベント告知だけの枠、商品カタログ、発行所情報は除外してください。',
    '最重要: 図表・ランキング表・グラフ・写真キャプションは、それ自体を独立記事にしないでください。対応する本文記事へ内容を統合し、has_table / has_chart / has_imageで示してください。紙面全体が図表または表だけで独立本文が無い場合に限り、tableまたはchartとして1件にしてください。',
    '別見出しと独立した本文枠がある場合だけ複数記事に分け、同一記事を細切れにしないでください。記事数は必要最小限にしてください。',
    '見出し、掲載日、企業名、サービス名、人物名、重要な数字・比較・ランキングなど、検索と再分析に必要な事実を本文へ保持してください。',
    '本文は紙面の読み順を推定して自然な順序に再構成してください。原文にない解釈、評価、マーケティング示唆、生活者インサイト、因果関係を追加しないでください。原文の情報量を超えて水増ししないでください。',
    '大きなランキング表・一覧表は全セルを逐語転記せず、表の対象・レンジ・主要な事実・検索上重要な固有名詞を本文に残してください。元OCRは別レコードで保持されているため、長大な表の完全転記は不要です。',
    'article_dateは紙面から確実に読める場合のみYYYY-MM-DD。不明なら空文字にしてください。',
    '',
    'Google Vision OCR（補助。段組み崩れ・広告混入あり）:',
    ocrText.slice(0, 7000)
  ].join('\n');
}

export async function segmentArticlesWithVertexImage(input: SegmentInput): Promise<VertexArticleCandidate[]> {
  const normalizedOcr = normalizeOcrText(input.ocrText);
  if (!normalizedOcr) throw new Error('Vertex article organization: OCR text is empty.');

  const credentials = credentialsFromEnv();
  const accessToken = await cloudPlatformToken(credentials);
  const model = process.env.VERTEX_ARTICLE_MODEL?.trim() || 'gemini-2.5-flash';
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(credentials.project_id)}/locations/global/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: articlePrompt(normalizedOcr) },
          {
            inlineData: {
              mimeType: input.mimeType || 'image/png',
              data: input.imageBuffer.toString('base64')
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Vertex article organization API ${response.status}: ${raw.slice(0, 1800)}`);
  }

  let responseJson: {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  try {
    responseJson = JSON.parse(raw) as typeof responseJson;
  } catch (error) {
    throw new Error(`Vertex article organization response JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const candidate = responseJson.candidates?.[0];
  const output = candidate?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
  if (!output) {
    throw new Error(`Vertex article organization returned empty output (finish=${candidate?.finishReason || 'unknown'}).`);
  }

  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(output);
  } catch (error) {
    throw new Error(`Vertex article organization structured JSON parse failed (finish=${candidate?.finishReason || 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = VertexArticleListSchema.safeParse(parsedOutput);
  if (!parsed.success) {
    throw new Error(`Vertex article organization schema mismatch: ${parsed.error.message}`);
  }

  return parsed.data.articles
    .map((article) => {
      const body = normalizeOcrText(article.body_reconstructed);
      return {
        headline: normalizeOcrText([article.headline, article.subheadline].filter(Boolean).join(' / ')) || firstLikelyHeadline(normalizedOcr),
        article_date: validDate(article.article_date),
        ocr_text: body,
        article_type: article.article_type,
        has_table: article.has_table,
        has_chart: article.has_chart,
        has_image: article.has_image
      } satisfies VertexArticleCandidate;
    })
    .filter((article) => article.article_type !== 'caption' && article.ocr_text.length > 0);
}
