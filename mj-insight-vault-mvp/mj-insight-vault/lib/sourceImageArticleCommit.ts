import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildEmbeddingText } from '@/lib/text';
import { embedText, TEXT_MODEL, VISION_MODEL } from '@/lib/openai';
import type { ArticleCandidate } from '@/lib/articleSegmentation';

type JsonRecord = Record<string, unknown>;

type AnalysisTextOrigin = 'vision_llm_reconstruction' | 'text_llm_segmentation' | 'raw_ocr_fallback';

export type CommittedArticle = JsonRecord & {
  id: string;
  headline?: string | null;
  article_date?: string | null;
  article_index?: number | null;
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

export type ProvenanceResult = {
  traceable_article_ids: string[];
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
  return text(error) || 'unknown persistence error';
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function comparable(value: unknown) {
  return text(value).replace(/\s+/g, ' ');
}

function reconstructionConfidence(value: unknown) {
  const match = text(value).match(/【全体信頼度】(high|medium|low)/i);
  return match?.[1]?.toLowerCase() || 'unknown';
}

function provenanceForCandidate(candidate: ArticleCandidate, sourceOcrText: string) {
  const analysisText = text(candidate.ocr_text);
  const normalizedSource = comparable(sourceOcrText);
  const normalizedAnalysis = comparable(analysisText);
  let origin: AnalysisTextOrigin;
  let model: string;
  let promptVersion: string;
  let inference: string;

  if (analysisText.startsWith('【GPT記事構造化】')) {
    origin = 'vision_llm_reconstruction';
    model = VISION_MODEL;
    promptVersion = 'vision_article_structure_responses_schema_v1';
    inference = 'persisted_analysis_text_marker';
  } else if (normalizedAnalysis === normalizedSource) {
    origin = 'raw_ocr_fallback';
    model = 'none';
    promptVersion = 'raw_ocr_fallback_v1';
    inference = 'analysis_text_equals_normalized_source_ocr';
  } else {
    origin = 'text_llm_segmentation';
    model = TEXT_MODEL;
    promptVersion = 'text_article_segmentation_chat_json_v1';
    inference = 'non_vision_analysis_text_differs_from_source_ocr';
  }

  return {
    analysis_text_origin: origin,
    source_ocr_sha256: sha256(sourceOcrText),
    analysis_text_sha256: sha256(analysisText),
    reconstruction_model: model,
    reconstruction_prompt_version: promptVersion,
    reconstruction_confidence: reconstructionConfidence(analysisText),
    provenance_status: 'traceable',
    provenance_json: {
      provenance_version: 'article_text_provenance_v1',
      source_ocr_available: Boolean(text(sourceOcrText)),
      source_hash_algorithm: 'sha256',
      analysis_hash_algorithm: 'sha256',
      path_inference: inference,
      model_exactly_known_from_runtime_config: model !== 'none',
      prompt_version_declared_by_current_writer: true
    },
    updated_at: new Date().toISOString()
  };
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

async function recordProvenanceFailure(articleId: string, message: string) {
  const { error } = await supabaseAdmin
    .from('articles')
    .update({
      provenance_status: 'failed',
      provenance_json: {
        provenance_version: 'article_text_provenance_v1',
        error: message.slice(0, 2000)
      },
      updated_at: new Date().toISOString()
    })
    .eq('id', articleId);
  if (error) console.error('Failed to persist provenance error:', articleId, error.message);
}

export async function persistCommittedArticleProvenance(input: {
  articles: CommittedArticle[];
  candidates: ArticleCandidate[];
  sourceOcrText: string;
}): Promise<ProvenanceResult> {
  const traceableArticleIds: string[] = [];
  const failed: Array<{ article_id: string; error: string }> = [];

  for (const article of input.articles) {
    try {
      const index = Math.max(0, Math.round(number(article.article_index)));
      const candidate = input.candidates[index];
      if (!candidate) throw new Error(`candidate not found for article_index=${index}`);
      if (!text(input.sourceOcrText)) throw new Error('source OCR text is empty');
      if (!text(candidate.ocr_text)) throw new Error('analysis text is empty');

      const { error } = await supabaseAdmin
        .from('articles')
        .update(provenanceForCandidate(candidate, input.sourceOcrText))
        .eq('id', article.id);
      if (error) throw error;
      traceableArticleIds.push(article.id);
    } catch (error) {
      const message = errorMessage(error);
      failed.push({ article_id: article.id, error: message });
      await recordProvenanceFailure(article.id, message);
    }
  }

  return { traceable_article_ids: traceableArticleIds, failed };
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
