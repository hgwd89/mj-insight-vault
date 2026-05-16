import { z } from 'zod';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
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

function toDataUrl(buffer: Buffer, mimeType: string) {
  return `data:${mimeType || 'image/png'};base64,${buffer.toString('base64')}`;
}

function formatArticleText(input: {
  body_reconstructed?: string;
  facts?: string[];
  companies?: string[];
  services?: string[];
  people?: string[];
  numbers?: Array<{ label?: string; value?: string; note?: string; confidence?: string }>;
  figures?: Array<{ title?: string; summary?: string; confidence?: string }>;
  noise?: string[];
  confidence?: string;
  raw_ocr_reference?: string;
}) {
  const lines: string[] = [];

  if (input.body_reconstructed) {
    lines.push('【本文再構成】');
    lines.push(input.body_reconstructed.trim());
    lines.push('');
  }

  if (input.facts?.length) {
    lines.push('【主要事実】');
    input.facts.forEach((fact) => lines.push(`- ${fact}`));
    lines.push('');
  }

  const entities = [
    input.companies?.length ? `企業: ${input.companies.join('、')}` : null,
    input.services?.length ? `サービス/ブランド: ${input.services.join('、')}` : null,
    input.people?.length ? `人物: ${input.people.join('、')}` : null
  ].filter(Boolean);

  if (entities.length) {
    lines.push('【固有名詞】');
    entities.forEach((line) => lines.push(String(line)));
    lines.push('');
  }

  if (input.numbers?.length) {
    lines.push('【数字・根拠】');
    input.numbers.forEach((n) => {
      lines.push(`- ${n.label || '項目不明'}: ${n.value || '値不明'}${n.note ? `（${n.note}）` : ''}${n.confidence ? ` [confidence: ${n.confidence}]` : ''}`);
    });
    lines.push('');
  }

  if (input.figures?.length) {
    lines.push('【図表】');
    input.figures.forEach((f) => {
      lines.push(`- ${f.title || '図表'}: ${f.summary || ''}${f.confidence ? ` [confidence: ${f.confidence}]` : ''}`);
    });
    lines.push('');
  }

  if (input.noise?.length) {
    lines.push('【除外ノイズ】');
    input.noise.forEach((n) => lines.push(`- ${n}`));
    lines.push('');
  }

  if (input.confidence) {
    lines.push(`【全体信頼度】${input.confidence}`);
    lines.push('');
  }

  if (input.raw_ocr_reference) {
    lines.push('【OCR参照テキスト】');
    lines.push(input.raw_ocr_reference.trim());
  }

  return normalizeOcrText(lines.join('\n'));
}

const VisionArticleSchema = z.object({
  articles: z.array(z.object({
    headline: z.string().default('無題の記事候補'),
    subheadline: z.string().nullable().optional(),
    article_date: z.string().nullable().optional(),
    article_type: z.enum(['article', 'table', 'chart', 'caption', 'unknown']).default('article'),
    body_reconstructed: z.string().default(''),
    facts: z.array(z.string()).default([]),
    companies: z.array(z.string()).default([]),
    services: z.array(z.string()).default([]),
    people: z.array(z.string()).default([]),
    numbers: z.array(z.object({
      label: z.string().optional(),
      value: z.string().optional(),
      note: z.string().optional(),
      confidence: z.enum(['high', 'medium', 'low']).optional()
    })).default([]),
    figures: z.array(z.object({
      title: z.string().optional(),
      summary: z.string().optional(),
      confidence: z.enum(['high', 'medium', 'low']).optional()
    })).default([]),
    noise: z.array(z.string()).default([]),
    confidence: z.enum(['high', 'medium', 'low']).default('medium'),
    has_table: z.boolean().default(false),
    has_chart: z.boolean().default(false),
    has_image: z.boolean().default(false)
  })).min(1).max(8)
});

export async function segmentArticlesFromImage(input: SegmentFromImageInput): Promise<ArticleCandidate[]> {
  const normalizedOcr = normalizeOcrText(input.ocrText);
  const openai = getOpenAI();

  if (!openai) {
    return segmentArticles(normalizedOcr);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: TEXT_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'あなたは日経MJ紙面をニュースDB化する編集者です。',
            '目的は生活者インサイトの生成ではなく、後から分析できるようにニュース事実をできるだけ忠実に構造化することです。',
            '画像とOCRテキストを照合し、紙面内の記事候補を抽出してください。',
            '広告、購読案内、発行所情報、無関係な別記事見出しはnoiseへ分離してください。',
            '記事に書かれていない解釈、示唆、生活者インサイトは入れないでください。',
            '不確かな数字・固有名詞はconfidenceをmediumまたはlowにしてください。',
            '本文の完全復元よりも、見出し、主題、企業名、サービス名、人物名、数字、事実関係の保存を優先してください。',
            '出力は必ずJSONのみ。'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '以下は日経MJ紙面画像とGoogle Vision OCRの生テキストです。',
                '画像を優先しつつ、OCRテキストも照合して記事候補を抽出してください。',
                '',
                '返却JSON形式:',
                '{',
                '  "articles": [',
                '    {',
                '      "headline": "記事見出し",',
                '      "subheadline": "サブ見出し。不明ならnull",',
                '      "article_date": "YYYY-MM-DD。不明ならnull",',
                '      "article_type": "article|table|chart|caption|unknown",',
                '      "body_reconstructed": "記事本文を自然な順番で再構成。ただし推測で補いすぎない",',
                '      "facts": ["記事内の主要事実"],',
                '      "companies": ["企業名"],',
                '      "services": ["サービス名・ブランド名"],',
                '      "people": ["人物名"],',
                '      "numbers": [{"label":"項目名","value":"数値","note":"補足","confidence":"high|medium|low"}],',
                '      "figures": [{"title":"図表名","summary":"図表から読める内容","confidence":"high|medium|low"}],',
                '      "noise": ["広告、購読案内、別記事見出しなど"],',
                '      "confidence": "high|medium|low",',
                '      "has_table": true,',
                '      "has_chart": true,',
                '      "has_image": true',
                '    }',
                '  ]',
                '}',
                '',
                'OCRテキスト:',
                normalizedOcr.slice(0, 14000)
              ].join('\n')
            },
            {
              type: 'image_url',
              image_url: {
                url: toDataUrl(input.imageBuffer, input.mimeType),
                detail: 'high'
              }
            }
          ]
        }
      ]
    });

    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = VisionArticleSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      return segmentArticles(normalizedOcr);
    }

    return parsed.data.articles
      .map((article) => {
        const headline = normalizeOcrText(
          [article.headline, article.subheadline].filter(Boolean).join(' / ')
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
          confidence: article.confidence,
          raw_ocr_reference: normalizedOcr.slice(0, 3500)
        });

        return {
          headline,
          article_date: article.article_date || null,
          ocr_text: ocrText || normalizedOcr,
          article_type: article.article_type,
          has_table: article.has_table,
          has_chart: article.has_chart,
          has_image: article.has_image
        };
      })
      .filter((article) => article.ocr_text.length > 0);
  } catch (error) {
    console.error('Vision article structuring failed:', error);
    return segmentArticles(normalizedOcr);
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
