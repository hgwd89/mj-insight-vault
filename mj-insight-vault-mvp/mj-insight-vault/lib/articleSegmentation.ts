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

const CandidateListSchema = z.object({ articles: z.array(ArticleCandidateSchema).min(1).max(8) });

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
    const parsed = CandidateListSchema.safeParse(JSON.parse(completion.choices[0]?.message.content || '{}'));
    if (!parsed.success) return [fallbackArticle(normalized)];
    return parsed.data.articles.map((a) => ({ ...a, ocr_text: normalizeOcrText(a.ocr_text) })).filter((a) => a.ocr_text.length > 0);
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
