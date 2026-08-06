import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;

type ClassificationJob = {
  id: string;
  article_id: string;
  model: string;
  attempt_count: number;
  lease_token: string;
};

type ArticleRow = {
  id: string;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
};

type CategoryRow = {
  id: string;
  name_ja: string;
  description: string | null;
  keywords: string[] | null;
};

const CLASSIFIER_VERSION = 'article_category_profile_v2';
const DEFAULT_MODEL = process.env.OPENAI_CLASSIFICATION_MODEL || 'gpt-4o-mini';
const MAX_JOBS_PER_STEP = 6;
const ARTICLE_TEXT_LIMIT = 3600;
const CALL_TIMEOUT_MS = 180_000;

type ClassificationOutput = {
  article_id: string;
  primary_category: string;
  secondary_categories: string[];
  consumer_scene: string;
  market_signal: string;
  product_type: string;
  consumer_need: string;
  confidence: number;
  reason: string;
  memberships: Array<{
    category_id: string;
    score: number;
    confidence: number;
    match_terms: string[];
    reason: string;
  }>;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function bounded01(value: unknown) {
  const parsed = number(value);
  if (!Number.isFinite(parsed)) throw new Error('classification confidence is not numeric');
  if (parsed < 0 || parsed > 1) throw new Error('classification confidence is outside 0..1');
  return Math.round(parsed * 1000) / 1000;
}

function stringArray(value: unknown, max = 12) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(text).filter(Boolean))).slice(0, max);
}

function classifyError(error: unknown) {
  const record = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : text(record.message || record.error || error);
  const lower = message.toLowerCase();
  const status = Number(record.status || record.statusCode || 0);
  const retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(status)
    || lower.includes('rate limit')
    || lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('temporarily unavailable')
    || lower.includes('fetch failed')
    || lower.includes('network')
    || lower.includes('connection reset');
  return { message: message || 'article classification failed', retryable };
}

function parseOutput(value: unknown, allowedArticleIds: Set<string>, allowedCategoryIds: Set<string>): ClassificationOutput[] {
  const root = isRecord(value) ? value : {};
  const raw = Array.isArray(root.classifications) ? root.classifications : [];
  const outputs: ClassificationOutput[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const articleId = text(item.article_id);
    if (!allowedArticleIds.has(articleId) || seen.has(articleId)) continue;
    const primary = text(item.primary_category);
    if (!allowedCategoryIds.has(primary)) throw new Error(`invalid primary category for ${articleId}: ${primary}`);

    const membershipItems = Array.isArray(item.memberships) ? item.memberships : [];
    const memberships: ClassificationOutput['memberships'] = [];
    const membershipIds = new Set<string>();
    for (const membership of membershipItems) {
      if (!isRecord(membership)) continue;
      const categoryId = text(membership.category_id);
      if (!allowedCategoryIds.has(categoryId) || membershipIds.has(categoryId)) continue;
      membershipIds.add(categoryId);
      memberships.push({
        category_id: categoryId,
        score: bounded01(membership.score ?? membership.confidence),
        confidence: bounded01(membership.confidence),
        match_terms: stringArray(membership.match_terms, 12),
        reason: text(membership.reason).slice(0, 600)
      });
      if (memberships.length >= 4) break;
    }
    if (!membershipIds.has(primary)) throw new Error(`primary category missing from memberships for ${articleId}`);
    if (!memberships.length) throw new Error(`no memberships for ${articleId}`);

    outputs.push({
      article_id: articleId,
      primary_category: primary,
      secondary_categories: stringArray(item.secondary_categories, 3).filter((id) => allowedCategoryIds.has(id) && id !== primary),
      consumer_scene: text(item.consumer_scene).slice(0, 800),
      market_signal: text(item.market_signal).slice(0, 800),
      product_type: text(item.product_type).slice(0, 300),
      consumer_need: text(item.consumer_need).slice(0, 800),
      confidence: bounded01(item.confidence),
      reason: text(item.reason).slice(0, 1000),
      memberships
    });
    seen.add(articleId);
  }

  return outputs;
}

async function claimJobs(limit: number) {
  const { data, error } = await supabaseAdmin.rpc('claim_article_classification_jobs_v2', {
    p_limit: Math.max(1, Math.min(MAX_JOBS_PER_STEP, Math.round(limit))),
    p_lease_seconds: 210
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).filter(isRecord).map((row) => ({
    id: text(row.id),
    article_id: text(row.article_id),
    model: text(row.model) || DEFAULT_MODEL,
    attempt_count: Number(row.attempt_count || 0),
    lease_token: text(row.lease_token)
  })).filter((row): row is ClassificationJob => Boolean(row.id && row.article_id && row.lease_token));
}

async function loadInputs(jobs: ClassificationJob[]) {
  const articleIds = jobs.map((job) => job.article_id);
  const [{ data: articles, error: articleError }, { data: categories, error: categoryError }] = await Promise.all([
    supabaseAdmin
      .from('formal_corpus_articles_v1')
      .select('id,headline,article_date,ocr_text')
      .in('id', articleIds),
    supabaseAdmin
      .from('analysis_categories')
      .select('id,name_ja,description,keywords')
      .eq('is_active', true)
      .order('id', { ascending: true })
  ]);
  if (articleError) throw articleError;
  if (categoryError) throw categoryError;
  const byId = new Map((articles || []).map((article) => [text(article.id), article as ArticleRow]));
  return {
    articles: jobs.map((job) => byId.get(job.article_id)).filter(Boolean) as ArticleRow[],
    categories: (categories || []) as CategoryRow[]
  };
}

async function classifyBatch(jobs: ClassificationJob[], articles: ArticleRow[], categories: CategoryRow[]) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');
  if (!jobs.length || !articles.length) throw new Error('no classification jobs loaded');
  const model = jobs[0].model || DEFAULT_MODEL;
  if (jobs.some((job) => job.model !== model)) throw new Error('classification batch contains mixed models');

  const payload = {
    task: 'Classify each supplied MJ article into the provided analysis categories. Do not infer consumer demand from company activity alone. Use other_unclassified when evidence is insufficient or no category fits.',
    classifier_version: CLASSIFIER_VERSION,
    required_output: {
      classifications: [{
        article_id: 'exact supplied UUID',
        primary_category: 'one active category id',
        secondary_categories: 'zero to three additional active category ids',
        consumer_scene: 'observable consumer or use scene; empty when absent',
        market_signal: 'market-side observable signal, separated from consumer proof',
        product_type: 'short product/service type',
        consumer_need: 'supported need or tension; explicitly uncertain when inferred',
        confidence: '0..1',
        reason: 'brief evidence-grounded reason',
        memberships: [{ category_id: 'active id', score: '0..1 relevance', confidence: '0..1', match_terms: ['article wording'], reason: 'why this category applies' }]
      }]
    },
    categories: categories.map((category) => ({
      id: category.id,
      name_ja: category.name_ja,
      description: category.description || '',
      keywords: category.keywords || []
    })),
    articles: articles.map((article) => ({
      article_id: article.id,
      headline: article.headline || '',
      article_date: article.article_date || '',
      text: text(article.ocr_text).replace(/\s+/g, ' ').slice(0, ARTICLE_TEXT_LIMIT)
    }))
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You are a strict Japanese market-research classification analyst.',
            'Return JSON only. Classify every supplied article exactly once.',
            'Never invent category IDs or article IDs.',
            'A product launch is a market signal, not proof of consumer demand.',
            'Use other_unclassified rather than forcing a weak match.',
            'Use at most four category memberships per article.'
          ].join('\n')
        },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    }, { signal: controller.signal });
    const content = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(content);
    return parseOutput(parsed, new Set(jobs.map((job) => job.article_id)), new Set(categories.map((category) => category.id)));
  } finally {
    clearTimeout(timer);
  }
}

async function completeJob(job: ClassificationJob, output: ClassificationOutput) {
  const { data, error } = await supabaseAdmin.rpc('complete_article_classification_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_profile: {
      primary_category: output.primary_category,
      secondary_categories: output.secondary_categories,
      consumer_scene: output.consumer_scene,
      market_signal: output.market_signal,
      product_type: output.product_type,
      consumer_need: output.consumer_need,
      confidence: output.confidence,
      reason: output.reason
    },
    p_memberships: output.memberships
  });
  if (error) throw error;
  return data;
}

async function failJob(job: ClassificationJob, error: unknown, retryableOverride?: boolean) {
  const classified = classifyError(error);
  const { data, error: updateError } = await supabaseAdmin.rpc('fail_article_classification_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: classified.message,
    p_retryable: retryableOverride ?? classified.retryable
  });
  if (updateError) console.error('Classification failure persistence failed:', job.id, updateError.message);
  return data;
}

export async function runArticleClassificationWorkerStep(limit = MAX_JOBS_PER_STEP) {
  const jobs = await claimJobs(limit);
  if (!jobs.length) return { claimed: 0, completed: 0, failed: 0, retry_scheduled: 0, results: [] as unknown[] };

  try {
    const { articles, categories } = await loadInputs(jobs);
    if (articles.length !== jobs.length) throw new Error(`classification article payload mismatch: expected ${jobs.length}, loaded ${articles.length}`);
    const outputs = await classifyBatch(jobs, articles, categories);
    const byArticle = new Map(outputs.map((output) => [output.article_id, output]));
    const results: unknown[] = [];
    let completed = 0;
    let failed = 0;
    let retryScheduled = 0;

    for (const job of jobs) {
      const output = byArticle.get(job.article_id);
      if (!output) {
        const result = await failJob(job, new Error(`model omitted article ${job.article_id}`), true);
        results.push(result);
        failed += 1;
        if (isRecord(result) && result.retry_scheduled === true) retryScheduled += 1;
        continue;
      }
      try {
        results.push(await completeJob(job, output));
        completed += 1;
      } catch (error) {
        results.push(await failJob(job, error));
        failed += 1;
      }
    }

    return { claimed: jobs.length, completed, failed, retry_scheduled: retryScheduled, results };
  } catch (error) {
    const results = await Promise.all(jobs.map((job) => failJob(job, error)));
    return {
      claimed: jobs.length,
      completed: 0,
      failed: jobs.length,
      retry_scheduled: results.filter((result) => isRecord(result) && result.retry_scheduled === true).length,
      error: classifyError(error).message,
      results
    };
  }
}

export async function getArticleClassificationStatus() {
  const { data: status, error } = await supabaseAdmin
    .from('article_classification_status_v2')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  const { data: gate, error: gateError } = await supabaseAdmin
    .from('category_classification_gate_v1')
    .select('*')
    .maybeSingle();
  if (gateError) throw gateError;
  return { classifier_version: CLASSIFIER_VERSION, status: status || {}, category_gate: gate || {} };
}
