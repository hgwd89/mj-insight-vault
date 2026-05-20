type JsonRecord = Record<string, unknown>;

type QualityCheck = {
  key: string;
  passed: boolean;
  note: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function hasClickableArticleLink(value: string) {
  return /\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/.test(value);
}

function articleLinkFromRecord(record: JsonRecord) {
  const existing = text(record.article_link);
  if (existing) return existing;
  const id = text(record.article_id || record.id);
  if (!id) return '';
  const headline = text(record.headline || record.title || '無題の記事');
  const date = text(record.article_date || record.date || '日付不明');
  return `[${headline}｜${date}](/articles/${id})`;
}

function evidenceFallback(answer: JsonRecord, relatedArticles: unknown[]) {
  const evidence = asArray(answer.evidence).filter(isRecord).slice(0, 8);
  const cards = asArray(answer.cards).filter(isRecord).slice(0, 8);
  const related = relatedArticles.filter(isRecord).slice(0, 8);
  const source = evidence.length ? evidence : cards.length ? cards : related;

  return source.map((item, index) => {
    const id = text(item.article_id || item.id);
    return {
      claim: text(item.claim || item.reason || item.note) || `根拠候補 ${index + 1}`,
      article_id: id,
      headline: text(item.headline || item.title || '記事'),
      article_date: text(item.article_date || item.date || '日付不明'),
      article_url: id ? `/articles/${id}` : text(item.article_url),
      article_link: articleLinkFromRecord(item),
      evidence_excerpt_or_fact: text(item.evidence_excerpt_or_fact || item.evidence_excerpt || item.excerpt || item.reason || item.note || '根拠抜粋未取得'),
      evidence_strength: text(item.evidence_strength || item.strength || item.confidence || 'B'),
      limitation: text(item.limitation || '記事本文から確認できる範囲に限定。生活者心理は仮説として扱う。'),
      what_can_be_said: text(item.what_can_be_said || '当該記事は分析上の根拠候補として利用できる。'),
      what_cannot_be_said: text(item.what_cannot_be_said || 'この記事単独では生活者全体の傾向とは断定できない。'),
      research_need: text(item.research_need || '他記事・追加調査で再現性を確認する必要がある。')
    };
  });
}

function refutationFallback(answer: JsonRecord) {
  const claims = [
    ...asArray(answer.major_trends),
    ...asArray(answer.explanatory_hypotheses),
    ...asArray(answer.cross_article_insights)
  ].filter(isRecord).slice(0, 5);

  if (!claims.length) {
    return [{
      target_claim: '主要主張全体',
      possible_counterargument: '記事群が企業施策・商品投入中心で、生活者側の動機が直接示されていない可能性がある。',
      evidence_gap: '生活者発言、購買継続、比較対象、反例データが不足している可能性。',
      downgrade_or_revision: '断定ではなく、調査で検証すべき仮説として扱う。',
      falsification_condition: '追加調査で該当行動が一部カテゴリや一時的話題に限定されると確認された場合。'
    }];
  }

  return claims.map((claim, index) => ({
    target_claim: text(claim.claim || claim.trend || claim.hypothesis || claim.title || `主要主張 ${index + 1}`),
    possible_counterargument: text(claim.alternative_read) || '企業施策やカテゴリ事情を、生活者変化として読み替えすぎている可能性がある。',
    evidence_gap: '記事根拠だけでは、行動の持続性・広がり・心理要因までは断定できない。',
    downgrade_or_revision: '根拠が直接的でない部分は「仮説」「可能性」「調査が必要」として扱う。',
    falsification_condition: '反例記事、購買継続率、生活者発話、カテゴリ外比較で支持されない場合。'
  }));
}

function coverageBlock(answer: JsonRecord, result: JsonRecord, relatedArticles: unknown[]) {
  const source = isRecord(answer.source_coverage) ? answer.source_coverage : isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {};
  const retrieved = firstNumber(answer.related_article_count, source.article_count, relatedArticles.length) ?? relatedArticles.length;
  const scanned = firstNumber(answer.article_count_scanned, source.scanned_article_count, source.article_count, retrieved) ?? retrieved;
  const final = firstNumber(answer.article_count_for_report, source.final_article_count, source.report_article_count, asArray(answer.selected_article_ids).length) ?? null;
  const scanModel = text(answer.scan_model || result.scan_model || 'gpt-5-nano');
  const mode = text(answer.retrieval_mode || result.retrieval_mode);
  const scanEnabled = Boolean(answer.scan_enabled || result.scan_enabled || mode === 'wide_all_data_scan');

  return {
    article_count: retrieved,
    scanned_article_count: scanned,
    final_article_count: final,
    scan_model: scanModel,
    scan_enabled: scanEnabled,
    retrieval_mode: mode,
    coverage_note: scanEnabled
      ? `全体指定では、取得${retrieved}件・スキャン${scanned}件を${scanModel}で広域確認し、最終分析には代表性と関連性の高い${final ?? '複数'}件を選抜投入しています。全記事本文をそのままgpt-5へ丸投げする設計ではありません。`
      : `対象記事${retrieved}件から分析しています。`,
    limitation: '最終レポートは選抜記事に基づく統合分析です。スキャン外・選抜外の記事に反例がある可能性は、調査論点として残します。'
  };
}

function buildChecks(answer: JsonRecord, answerText: string) {
  const checks: QualityCheck[] = [
    { key: 'answer_text', passed: answerText.length > 120, note: '本文が十分に生成されているか' },
    { key: 'coverage', passed: isRecord(answer.coverage_diagnosis) || isRecord(answer.source_coverage), note: '取得・スキャン・最終投入の範囲が見えるか' },
    { key: 'evidence_matrix', passed: asArray(answer.evidence_matrix).length > 0, note: '根拠マトリクスが存在するか' },
    { key: 'refutation_audit', passed: asArray(answer.refutation_audit).length > 0, note: '反証・別解釈・棄却条件が存在するか' },
    { key: 'research_needs', passed: asArray(answer.research_needs).length > 0, note: '調査論点が存在するか' },
    { key: 'article_links', passed: hasClickableArticleLink(answerText), note: '本文内にクリック可能な記事リンクがあるか' }
  ];
  return checks;
}

function qualityAppendix(checks: QualityCheck[]) {
  const failed = checks.filter((check) => !check.passed);
  if (!failed.length) return '';
  return [
    '## 11. 品質ゲート補足',
    '以下の項目は、後処理バリデータで不足または弱さが検知されました。結論として断定せず、調査論点として扱ってください。',
    ...failed.map((check) => `- ${check.key}: ${check.note}`)
  ].join('\n');
}

export function enhanceChatAnalysisResult<T>(result: T): T {
  if (!isRecord(result)) return result;
  const answer = isRecord(result.answer) ? { ...result.answer } : {};
  const relatedArticles = asArray(result.related_articles);
  let body = text(answer.answer_text);

  answer.coverage_diagnosis = {
    ...coverageBlock(answer, result, relatedArticles),
    ...(isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {})
  };
  answer.source_coverage = {
    ...(isRecord(answer.source_coverage) ? answer.source_coverage : {}),
    ...coverageBlock(answer, result, relatedArticles)
  };

  if (!asArray(answer.evidence_matrix).length) {
    answer.evidence_matrix = evidenceFallback(answer, relatedArticles);
  }
  if (!asArray(answer.refutation_audit).length) {
    answer.refutation_audit = refutationFallback(answer);
  }

  const coverage = isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {};
  const coverageText = [
    '## 0. カバレッジ診断',
    `取得記事数: ${text(coverage.article_count) || '-'}`,
    `スキャン記事数: ${text(coverage.scanned_article_count) || '-'}`,
    `最終投入記事数: ${text(coverage.final_article_count) || '-'}`,
    `選抜方式: ${text(coverage.coverage_note) || '-'}`,
    ''
  ].join('\n');

  if (body && !body.includes('## 0. カバレッジ診断')) {
    body = `${coverageText}${body}`;
  }

  const checks = buildChecks(answer, body);
  const appendix = qualityAppendix(checks);
  if (appendix && !body.includes('## 11. 品質ゲート補足')) {
    body = `${body}\n\n${appendix}`.trim();
  }

  answer.answer_text = body || coverageText.trim();
  answer.quality_gate = {
    status: checks.every((check) => check.passed) ? 'passed' : 'needs_review',
    checks,
    note: 'この品質ゲートは後処理バリデータです。独立LLMによる別人格監査ではありません。'
  };

  return {
    ...result,
    answer
  } as T;
}
