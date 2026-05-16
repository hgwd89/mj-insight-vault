import { z } from 'zod';
import { getOpenAI, getOpenAIKey, TEXT_MODEL, VISION_MODEL } from '@/lib/openai';
import { detectFlags, firstLikelyHeadline, normalizeOcrText } from '@/lib/text';

export const ArticleCandidateSchema = z.object({
  headline: z.string(),
  article_date: z.string().nullable().optional(),
  ocr_text: z.string(),
  article_type: z.enum(['article', 'table', 'chart', 'caption', 'unknown']).default('article'),
  has_table: z.boolean().default(false),
  has_chart: z.boolean().default(false),
  has_image: z.boolean().default(false)
});

export type ArticleCandidate = z.infer<typeof ArticleCandidateSchema>;

const CandidateListSchema = z.object({
  articles: z.array(ArticleCandidateSchema).min(1).max(8)
});

type SegmentFromImageInput = {
  ocrText: string;
  imageBuffer: Buffer;
  mimeType: string;
};

const VisionArticleSchema = z.object({
  articles: z.array(z.object({
    headline: z.string(),
    subheadline: z.string(),
    article_date: z.string(),
    article_type: z.enum(['article', 'table', 'chart', 'caption', 'unknown']),
    body_reconstructed: z.string(),
    facts: z.array(z.string()),
    companies: z.array(z.string()),
    services: z.array(z.string()),
    people: z.array(z.string()),
    numbers: z.array(z.object({
      label: z.string(),
      value: z.string(),
      note: z.string(),
      confidence: z.enum(['high', 'medium', 'low'])
    })),
    figures: z.array(z.object({
      title: z.string(),
      summary: z.string(),
      confidence: z.enum(['high', 'medium', 'low'])
    })),
    noise: z.array(z.string()),
    confidence: z.enum(['high', 'medium', 'low']),
    has_table: z.boolean(),
    has_chart: z.boolean(),
    has_image: z.boolean()
  })).min(1).max(8)
});

const ARTICLE_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'mj_article_candidates',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['articles'],
    properties: {
      articles: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'headline',
            'subheadline',
            'article_date',
            'article_type',
            'body_reconstructed',
            'facts',
            'companies',
            'services',
            'people',
            'numbers',
            'figures',
            'noise',
            'confidence',
            'has_table',
            'has_chart',
            'has_image'
          ],
          properties: {
            headline: { type: 'string' },
            subheadline: { type: 'string' },
            article_date: { type: 'string' },
            article_type: {
              type: 'string',
              enum: ['article', 'table', 'chart', 'caption', 'unknown']
            },
            body_reconstructed: { type: 'string' },
            facts: {
              type: 'array',
              items: { type: 'string' }
            },
            companies: {
              type: 'array',
              items: { type: 'string' }
            },
            services: {
              type: 'array',
              items: { type: 'string' }
            },
            people: {
              type: 'array',
              items: { type: 'string' }
            },
            numbers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'value', 'note', 'confidence'],
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                  note: { type: 'string' },
                  confidence: {
                    type: 'string',
                    enum: ['high', 'medium', 'low']
                  }
                }
              }
            },
            figures: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'summary', 'confidence'],
                properties: {
                  title: { type: 'string' },
                  summary: { type: 'string' },
                  confidence: {
                    type: 'string',
                    enum: ['high', 'medium', 'low']
                  }
                }
              }
            },
            noise: {
              type: 'array',
              items: { type: 'string' }
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low']
            },
            has_table: { type: 'boolean' },
            has_chart: { type: 'boolean' },
            has_image: { type: 'boolean' }
          }
        }
      }
    }
  }
};

function toDataUrl(buffer: Buffer, mimeType: string) {
  return `data:${mimeType || 'image/png'};base64,${buffer.toString('base64')}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractResponseText(responseJson: unknown) {
  const json = responseJson as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  if (typeof json.output_text === 'string' && json.output_text.trim()) {
    return json.output_text;
  }

  const texts: string[] = [];

  for (const item of json.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string' && content.text.trim()) {
        texts.push(content.text);
      }
    }
  }

  return texts.join('\n').trim();
}

function formatArticleText(input: {
  body_reconstructed: string;
  facts: string[];
  companies: string[];
  services: string[];
  people: string[];
  numbers: Array<{ label: string; value: string; note: string; confidence: string }>;
  figures: Array<{ title: string; summary: string; confidence: string }>;
  noise: string[];
  confidence: string;
}) {
  const lines: string[] = [];

  lines.push('【GPT記事構造化】');
  lines.push('');

  if (input.body_reconstructed.trim()) {
    lines.push('【本文再構成】');
    lines.push(input.body_reconstructed.trim());
    lines.push('');
  }

  if (input.facts.length) {
    lines.push('【主要事実】');
    input.facts.forEach((fact) => lines.push(`- ${fact}`));
    lines.push('');
  }

  const entities = [
    input.companies.length ? `企業: ${input.companies.join('、')}` : null,
    input.services.length ? `サービス/ブランド: ${input.services.join('、')}` : null,
    input.people.length ? `人物: ${input.people.join('、')}` : null
  ].filter(Boolean);

  if (entities.length) {
    lines.push('【固有名詞】');
    entities.forEach((line) => lines.push(String(line)));
    lines.push('');
  }

  if (input.numbers.length) {
    lines.push('【数字・根拠】');
    input.numbers.forEach((n) => {
      lines.push(
        `- ${n.label || '項目不明'}: ${n.value || '値不明'}${n.note ? `（${n.note}）` : ''} [confidence: ${n.confidence}]`
      );
    });
    lines.push('');
  }

  if (input.figures.length) {
    lines.push('【図表】');
    input.figures.forEach((f) => {
      lines.push(`- ${f.title || '図表'}: ${f.summary || ''} [confidence: ${f.confidence}]`);
    });
    lines.push('');
  }

  if (input.noise.length) {
    lines.push('【除外ノイズ】');
    input.noise.forEach((n) => lines.push(`- ${n}`));
    lines.push('');
  }

  lines.push(`【全体信頼度】${input.confidence}`);

  return normalizeOcrText(lines.join('\n'));
}

async function structureArticlesWithResponsesAPI(input: SegmentFromImageInput) {
  const apiKey = getOpenAIKey();

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const normalizedOcr = normalizeOcrText(input.ocrText);

  const instructions = [
    'あなたは日経MJ紙面をニュースDB化する編集者です。',
    '目的は生活者インサイトの生成ではありません。',
    '目的は、後から生活者変化・市場変化・リサーチテーマを再分析できるように、ニュース事実をできるだけ忠実に保存することです。',
    '',
    '重要方針:',
    '- 画像を主情報として読み、Google Vision OCRテキストを補助情報として照合する。',
    '- OCRテキストは崩れている前提で扱い、丸写ししない。',
    '- 見出し、サブ見出し、媒体日付、企業名、サービス名、人物名、数字、図表、主要事実を優先して拾う。',
    '- 広告、購読案内、発行所情報、紙面下部広告、無関係な別記事見出しはnoiseに分離する。',
    '- 記事にない解釈、マーケティング示唆、生活者インサイトは入れない。',
    '- 不確かな数字・固有名詞はconfidenceをmediumまたはlowにする。',
    '- 本文再構成は自然な読み順に整える。ただし推測で補いすぎない。',
    '- 出力は必ず指定JSONスキーマに従う。'
  ].join('\n');

  const userText = [
    '以下は日経MJ紙面画像とGoogle Vision OCRの生テキストです。',
    '画像を優先しつつ、OCRテキストも照合して、ニュース記事候補を構造化してください。',
    '',
    'OCRテキスト:',
    normalizedOcr.slice(0, 12000)
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      store: false,
      temperature: 0.1,
      max_output_tokens: 5000,
      instructions,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: userText
            },
            {
              type: 'input_image',
              image_url: toDataUrl(input.imageBuffer, input.mimeType),
              detail: 'high'
            }
          ]
        }
      ],
      text: {
        format: ARTICLE_RESPONSE_FORMAT
      }
    })
  });

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error(`OpenAI Responses API failed: ${res.status} ${res.statusText} ${responseText}`);
  }

  let responseJson: unknown;

  try {
    responseJson = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`OpenAI Responses API returned non-JSON response: ${getErrorMessage(error)} | body=${responseText}`);
  }

  const outputText = extractResponseText(responseJson);

  if (!outputText) {
    throw new Error(`OpenAI Responses API returned empty output_text: ${responseText}`);
  }

  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(outputText);
  } catch (error) {
    throw new Error(`OpenAI structured article JSON parse failed: ${getErrorMessage(error)} | output=${outputText}`);
  }

  const parsed = VisionArticleSchema.safeParse(parsedOutput);

  if (!parsed.success) {
    throw new Error(`OpenAI structured article JSON schema mismatch: ${parsed.error.message} | output=${outputText}`);
  }

  return parsed.data.articles;
}

export async function segmentArticlesFromImage(input: SegmentFromImageInput): Promise<ArticleCandidate[]> {
  const normalizedOcr = normalizeOcrText(input.ocrText);

  try {
    const structuredArticles = await structureArticlesWithResponsesAPI(input);

    return structuredArticles
      .map((article) => {
        const headline = normalizeOcrText(
          [article.headline, article.subheadline].filter((v) => v && v.trim()).join(' / ')
        ) || '無題の記事候補';

        const ocrText = formatArticleText({
          body_reconstructed: article.body_reconstructed,
          facts: article.facts,
          companies: article.companies,
          services: article.services,
          people: article.people,
          numbers: article.numbers,
          figures: article.figures,
          noise: article.noise,
          confidence: article.confidence
        });

        return {
          headline,
          article_date: article.article_date.trim() || null,
          ocr_text: ocrText,
          article_type: article.article_type,
          has_table: article.has_table,
          has_chart: article.has_chart,
          has_image: article.has_image
        };
      })
      .filter((article) => article.ocr_text.length > 0);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error('GPT image article structuring failed:', errorMessage, error);

    return [
      fallbackArticle(
        normalizeOcrText(
          [
            `【GPT画像構造化失敗】${errorMessage}`,
            '',
            '【Google Vision OCR raw text】',
            normalizedOcr
          ].join('\n')
        )
      )
    ];
  }
}

export async function segmentArticles(text: string): Promise<ArticleCandidate[]> {
  const normalized = normalizeOcrText(text);
  if (!normalized) return [];

  const openai = getOpenAI();
  if (!openai) return [fallbackArticle(normalized)];

  try {
    const completion = await openai.chat.completions.create({
      model: TEXT_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'あなたは日本経済新聞MJのOCRテキストを記事候補に分割するアシスタントです。',
            '分析・要約はしない。画像1枚内に複数記事が混在する可能性があるため、見出し・本文・図表/表の有無を抽出する。',
            '不確かな場合は1記事候補にまとめ、status判断は後段に任せる。',
            '必ずJSONで {"articles":[...]} を返す。'
          ].join('\n')
        },
        {
          role: 'user',
          content: `OCRテキストを記事候補に分割してください。\n\n${normalized.slice(0, 12000)}`
        }
      ]
    });

    const parsed = CandidateListSchema.safeParse(
      JSON.parse(completion.choices[0]?.message.content || '{}')
    );

    if (!parsed.success) return [fallbackArticle(normalized)];

    return parsed.data.articles
      .map((a) => ({
        ...a,
        ocr_text: normalizeOcrText(a.ocr_text)
      }))
      .filter((a) => a.ocr_text.length > 0);
  } catch {
    return [fallbackArticle(normalized)];
  }
}

function fallbackArticle(text: string): ArticleCandidate {
  const flags = detectFlags(text);

  return {
    headline: firstLikelyHeadline(text),
    article_date: null,
    ocr_text: text,
    article_type: flags.hasChart ? 'chart' : flags.hasTable ? 'table' : 'article',
    has_table: flags.hasTable,
    has_chart: flags.hasChart,
    has_image: flags.hasImage
  };
}
