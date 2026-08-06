import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildEmbeddingText } from '@/lib/text';
import { embedText } from '@/lib/openai';
import type { ArticleCandidate } from '@/lib/articleSegmentation';

type JsonRecord = Record<string, unknown>;

export type CommittedArticle = JsonRecord & {
  id: string;
  headline?: string | null;
  article_date?: string | null;
  ocr_text?: string | null;
};

export type SourceImageCommitResult = {
  source_image_id: string;
  batch_id: string;
  replace_existing: boolean;
  previous_active_article_count: number;
  retired_article_ids: string[];
  created_articles: CommittedArticle[];
  duplicate_candidates: JsonRecord[];
  created_count: number;
  duplicate_count: number;
};

export type EnrichmentResult = {
  embedded_article_ids: string[];
  failed: Array<{ article_id: string; error: string }>;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function number(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function recordArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error)) return text(error.message || error.details || error.hint || error.code);
  return text(error) || 'unknown enrichment error';
}

function candidatePayload(candidate: ArticleCandidate) {
  return {
    headline: candidate.headline,
    article_date: candidate.article_date || null,
    ocr_text: candidate.ocr_text,
    article_type: candidate.article_type,
    has_table: candidate.has_table,
    has_chart: candidate.has_chart,
    has_image: candidate.has_image
  };
}

export async function commitSourceImageArticles(input: {
  imageId: string;
  candidates: ArticleCandidate[];
  fallbackArticleDate?: string | null;
  replaceExisting: boolean;
}): Promise<SourceImageCommitResult> {
  if (!input.candidates.length) throw new Error('article_candidates_required');

  const { data, error } = await supabaseAdmin.rpc('commit_source_image_articles_v1', {
    p_image_id: input.imageId,
    p_candidates: input.candidates.map(candidatePayload),
    p_fallback_article_date: input.fallbackArticleDate || null,
    p_replace_existing: input.replaceExisting
  });
  if (error) throw error;
  if (!isRecord(data)) throw new Error('atomic article commit returned an invalid payload');

  const created = recordArray(data.created_articles)
    .map((article) => ({ ...article, id: text(article.id) }))
    .filter((article): article is CommittedArticle => Boolean(article.id));

  return {
    source_image_id: text(data.source_image_id),
    batch_id: text(data.batch_id),
    replace_existing: data.replace_existing === true,
    previous_active_article_count: number(data.previous_active_article_count),
    retired_article_ids: stringArray(data.retired_article_ids),
    created_articles: created,
    duplicate_candidates: recordArray(data.duplicate_candidates),
    created_count: number(data.created_count),
    duplicate_count: number(data.duplicate_count)
  };
}

async function recordEnrichmentFailure(articleId: string, message: string) {
  const { error } = await supabaseAdmin
    .from('articles')
    .update({
      enrichment_status: 'embedding_failed',
      enrichment_error: message.slice(0, 2000),
      updated_at: new Date().toISOString()
    })
    .eq('id', articleId);
  if (error) console.error('Failed to persist embedding error:', articleId, error.message);
}

export async function enrichCommittedArticles(articles: CommittedArticle[]): Promise<EnrichmentResult> {
  const embeddedArticleIds: string[] = [];
  const failed: Array<{ article_id: string; error: string }> = [];

  for (const article of articles) {
    try {
      const embeddingText = buildEmbeddingText(article);
      const embedding = await embedText(embeddingText);
      if (!embedding) throw new Error('embedding provider returned no vector');

      const { error: embeddingError } = await supabaseAdmin
        .from('article_embeddings')
        .upsert({
          article_id: article.id,
          embedding_text: embeddingText,
          embedding_vector: embedding
        }, { onConflict: 'article_id' });
      if (embeddingError) throw embeddingError;

      const { error: statusError } = await supabaseAdmin
        .from('articles')
        .update({
          enrichment_status: 'embedded',
          enrichment_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', article.id);
      if (statusError) throw statusError;
      embeddedArticleIds.push(article.id);
    } catch (error) {
      const message = errorMessage(error);
      failed.push({ article_id: article.id, error: message });
      await recordEnrichmentFailure(article.id, message);
    }
  }

  return { embedded_article_ids: embeddedArticleIds, failed };
}
