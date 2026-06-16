import type { WideArticle } from '@/lib/wideArticleRetrieval';

type MonthlyContextLike = {
  has_rollups?: boolean;
  rollup_count?: number;
  article_count?: number;
  total_article_count?: number;
  coverage_complete?: boolean;
  ready_months?: string[];
  stale_months?: string[];
  failed_months?: string[];
  missing_months?: string[];
  running_months?: string[];
};

type CoverageLike = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function monthKey(value: unknown) {
  const date = text(value);
  const iso = date.match(/^(\d{4})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`;
  const jp = date.match(/^(\d{4})年\s*(\d{1,2})月/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}`;
  return 'undated';
}

function articleLink(article: WideArticle) {
  return `[${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}](/articles/${article.id})`;
}

function evidenceDistribution(articles: WideArticle[]) {
  const counts: Record<string, number> = {};
  for (const article of articles) {
    const key = monthKey(article.article_date);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function evidenceInventory(articles: WideArticle[]) {
  return articles.slice(0, 60).map((article, index) => ({
    no: index + 1,
    article_id: article.id,
    article_link: articleLink(article),
    headline: article.headline || '無題の記事',
    article_date: article.article_date || '日付不明',
    month_key: monthKey(article.article_date),
    available_excerpt: (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 220)
  }));
}

export function buildAnalysisQualityContract(params: {
  query: string;
  coverage: CoverageLike;
  monthlyContext: MonthlyContextLike | null;
  evidenceArticles: WideArticle[];
}) {
  const monthly = params.monthlyContext || {};
  const coverageComplete = Boolean(monthly.coverage_complete || params.coverage.monthly_rollup_coverage_complete);
  const activeArticleCount = Number(params.coverage.monthly_rollup_total_article_count || params.coverage.active_article_count || monthly.total_article_count || 0);
  const rollupArticleCount = Number(params.coverage.monthly_rollup_source_article_count || monthly.article_count || 0);

  return {
    contract_name: 'mj_analysis_quality_contract_v2',
    purpose: 'Model choice must not carry quality. Quality must come from evidence discipline, counter-reading, and coverage accounting.',
    user_query: params.query,
    coverage_requirements: {
      must_treat_monthly_rollups_as_primary_corpus: Boolean(monthly.has_rollups),
      coverage_complete: coverageComplete,
      active_article_count: activeArticleCount,
      monthly_rollup_source_article_count: rollupArticleCount,
      ready_months: monthly.ready_months || [],
      missing_months: monthly.missing_months || [],
      stale_months: monthly.stale_months || [],
      failed_months: monthly.failed_months || [],
      running_months: monthly.running_months || [],
      if_incomplete: 'Mark the report as provisional and do not present findings as complete.'
    },
    evidence_requirements: {
      every_major_claim_needs_article_link: true,
      prefer_two_or_more_articles_per_major_claim: true,
      separate_fact_inference_and_hypothesis: true,
      include_direct_observation: 'What the article explicitly says.',
      include_inference: 'What can be inferred from cross-article pattern.',
      include_boundary: 'What cannot be concluded from the evidence.',
      include_counter_evidence_or_missing_evidence: true,
      do_not_use_generic_consumer_trend_language_without_article_evidence: true
    },
    required_output_objects: {
      evidence_matrix: ['claim', 'article_link', 'evidence_excerpt_or_fact', 'what_can_be_said', 'what_cannot_be_said', 'evidence_strength'],
      refutation_audit: ['target_claim', 'possible_counterargument', 'evidence_gap', 'downgrade_or_revision', 'falsification_condition'],
      research_needs: ['question', 'why_it_matters', 'needed_data', 'method_hint'],
      negative_space: ['expected_but_weak_or_absent_theme', 'why_absence_matters', 'what_to_check_next'],
      confidence_rubric: ['claim', 'confidence', 'reason_for_confidence', 'reason_for_uncertainty']
    },
    interpretation_rules: [
      'Do not convert company initiatives into consumer insight unless the article evidence supports consumer behavior or adoption.',
      'When the evidence is only product launches or retailer actions, label it as market-side signal, not consumer-side proof.',
      'Distinguish repeated theme, isolated example, weak signal, and contradiction.',
      'If a theme appears in only one article, call it a hypothesis or example, not a trend.',
      'For WHY analysis, stop before unsupported psychology. Mark unsupported steps as hypotheses.'
    ],
    evidence_distribution_by_month: evidenceDistribution(params.evidenceArticles),
    evidence_inventory: evidenceInventory(params.evidenceArticles)
  };
}
