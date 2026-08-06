import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;

type ClaimedJob = {
  id: string;
  article_id: string;
  model: string;
  attempt_count: number;
  lease_token: string;
};

type Membership = {
  category_id: string;
  score: number;
  confidence: number;
  match_terms: string[];
  reason: string;
};

const CLASSIFIER_VERSION = 'article_category_profile_v2';
const DEFAULT_MODEL = process.env.OPENAI_CLASSIFICATION_MODEL || 'gpt-4o-mini';
const ARTICLE_TEXT_LIMIT = 3600;
const CALL_TIMEOUT_MS = 180_000;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function bounded01(value: unknown, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.max(0, Math.min(1, parsed)) * 1000) / 1000;
}

function stringArray(value: unknown, max: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(text).filter(Boolean))).slice(0, max);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return text(error.message || error.error || error);
  return text(error) || 'article classification failed';
}

async function claimOneJob() {
  const { data, error } = await supabaseAdmin.rpc('claim_article_classification_jobs_v2', {
    p_limit: 1,
    p_lease_seconds: 210
  });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job: ClaimedJob = {
    id: text(row.id),
    article_id: text(row.article_id),
    model: text(row.model) || DEFAULT_MODEL,
    attempt_count: Number(row.attempt_count || 0),
    lease_token: text(row.lease_token)
  };
  if (!job.id || !job.article_id || !job.lease_token) throw new Error('invalid claimed classification job');
  return job;
}

async function loadInput(job: ClaimedJob) {
  const [{ data: article, error: articleError }, { data: categories, error: categoryError }] = await Promise.all([
    supabaseAdmin
      .from('formal_corpus_articles_v1')
      .select('id,headline,article_date,ocr_text')
      .eq('id', job.article_id)
      .maybeSingle(),
    supabaseAdmin
      .from('analysis_categories')
      .select('id,name_ja,description,keywords')
      .eq('is_active', true)
      .order('id', { ascending: true })
  ]);
  if (articleError) throw articleError;
  if (categoryError) throw categoryError;
  if (!article) throw new Error(`classification article not found: ${job.article_id}`);
  return { article, categories: categories || [] };
}

function parseMemberships(value: unknown, allowedCategoryIds: Set<string>) {
  if (!Array.isArray(value)) return [] as Membership[];
  const byCategory = new Map<string, Membership>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const categoryId = text(raw.category_id);
    if (!allowedCategoryIds.has(categoryId)) continue;
    const confidence = bounded01(raw.confidence, 0.5);
    const membership: Membership = {
      category_id: categoryId,
      score: bounded01(raw.score, confidence),
      confidence,
      match_terms: stringArray(raw.match_terms, 12),
      reason: text(raw.reason).slice(0, 600)
    };
    const previous = byCategory.get(categoryId);
    if (!previous || membership.score > previous.score) byCategory.set(categoryId, membership);
  }
  return Array.from(byCategory.values()).sort((a, b) => b.score - a.score).slice(0, 4);
}

function parseClassification(value: unknown, job: ClaimedJob, allowedCategoryIds: Set<string>) {
  const root = isRecord(value) ? value : {};
  const rows = Array.isArray(root.classifications) ? root.classifications : [];
  const item = rows.find((row) => isRecord(row) && text(row.article_id) === job.article_id);
  if (!isRecord(item)) throw new Error(`model omitted article ${job.article_id}`);

  const memberships = parseMemberships(item.memberships, allowedCategoryIds);
  if (!memberships.length) throw new Error(`model returned no valid memberships for ${job.article_id}`);

  const suppliedPrimary = text(item.primary_category);
  const membershipIds = new Set(memberships.map((membership) => membership.category_id));
  const primaryCategory = allowedCategoryIds.has(suppliedPrimary) && membershipIds.has(suppliedPrimary)
    ? suppliedPrimary
    : memberships[0].category_id;

  const suppliedSecondary = stringArray(item.secondary_categories, 3)
    .filter((categoryId) => allowedCategoryIds.has(categoryId) && categoryId !== primaryCategory);
  const evidenceSecondary = memberships
    .map((membership) => membership.category_id)
    .filter((categoryId) => categoryId !== primaryCategory);
  const secondaryCategories = Array.from(new Set([...suppliedSecondary, ...evidenceSecondary])).slice(0, 3);

  return {
    profile: {
      primary_category: primaryCategory,
      secondary_categories: secondaryCategories,
      consumer_scene: text(item.consumer_scene).slice(0, 800),
      market_signal: text(item.market_signal).slice(0, 800),
      product_type: text(item.product_type).slice(0, 300),
      consumer_need: text(item.consumer_need).slice(0, 800),
      confidence: bounded01(item.confidence, memberships[0].confidence),
      reason: text(item.reason).slice(0, 1000),
      normalization: {
        supplied_primary_category: suppliedPrimary,
        primary_was_normalized: suppliedPrimary !== primaryCategory,
        normalization_rule: suppliedPrimary !== primaryCategory ? 'highest_evidence_membership' : 'none'
      }
    },
    memberships
  };
}

async function classify(job: ClaimedJob) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');
  const { article, categories } = await loadInput(job);
  const allowedCategoryIds = new Set(categories.map((category) => text(category.id)).filter(Boolean));
  const payload = {
    task: 'Classify this MJ article into the provided analysis categories. Do not infer consumer demand from company activity alone. Use other_unclassified when evidence is insufficient or no category fits.',
    classifier_version: CLASSIFIER_VERSION,
    categories: categories.map((category) => ({
      id: category.id,
      name_ja: category.name_ja,
      description: category.description || '',
      keywords: category.keywords || []
    })),
    article: {
      article_id: article.id,
      headline: article.headline || '',
      article_date: article.article_date || '',
      text: text(article.ocr_text).replace(/\s+/g, ' ').slice(0, ARTICLE_TEXT_LIMIT)
    },
    required_output: {
      classifications: [{
        article_id: 'exact supplied UUID',
        primary_category: 'one active category id also present in memberships',
        secondary_categories: 'zero to three additional active category ids',
        consumer_scene: 'observable consumer or use scene; empty when absent',
        market_signal: 'market-side observable signal, separated from consumer proof',
        product_type: 'short product/service type',
        consumer_need: 'supported need or tension; explicitly uncertain when inferred',
        confidence: '0..1',
        reason: 'brief evidence-grounded reason',
        memberships: [{
          category_id: 'active id',
          score: '0..1 relevance',
          confidence: '0..1',
          match_terms: ['article wording'],
          reason: 'why this category applies'
        }]
      }]
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create({
      model: job.model || DEFAULT_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You are a strict Japanese market-research classification analyst.',
            'Return JSON only and classify the supplied article exactly once.',
            'Never invent category IDs or article IDs.',
            'The primary_category must also appear in memberships.',
            'A product launch is a market signal, not proof of consumer demand.',
            'Use other_unclassified rather than forcing a weak match.',
            'Use at most four category memberships.'
          ].join('\n')
        },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    }, { signal: controller.signal });
    const parsed = JSON.parse(completion.choices[0]?.message.content || '{}');
    return parseClassification(parsed, job, allowedCategoryIds);
  } finally {
    clearTimeout(timer);
  }
}

async function persistFailure(job: ClaimedJob, error: unknown) {
  const message = errorMessage(error);
  const retryable = !message.includes('OPENAI_API_KEY is not configured');
  const { data, error: persistenceError } = await supabaseAdmin.rpc('fail_article_classification_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: message,
    p_retryable: retryable
  });
  if (persistenceError) throw persistenceError;
  return data;
}

export async function runSafeArticleClassificationWorkerStep() {
  const job = await claimOneJob();
  if (!job) return { claimed: 0, completed: 0, failed: 0, retry_scheduled: 0, results: [] as unknown[] };
  try {
    const output = await classify(job);
    const { data, error } = await supabaseAdmin.rpc('complete_article_classification_job_v2', {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_profile: output.profile,
      p_memberships: output.memberships
    });
    if (error) throw error;
    return { claimed: 1, completed: 1, failed: 0, retry_scheduled: 0, results: [data] };
  } catch (error) {
    const result = await persistFailure(job, error);
    return {
      claimed: 1,
      completed: 0,
      failed: 1,
      retry_scheduled: isRecord(result) && result.retry_scheduled === true ? 1 : 0,
      error: errorMessage(error),
      results: [result]
    };
  }
}
