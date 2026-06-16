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

function countClickableArticleLinks(value: string) {
  return (value.match(/\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/g) || []).length;
}

function articleLinkFromRecord(record: JsonRecord) {
  const existing = text(record.article_link);
  if (hasClickableArticleLink(existing)) return existing;
  const id = text(record.article_id || record.id);
  if (!id) return '';
  const headline = text(record.headline || record.title || '無題の記事');
  const date = text(record.article_date || record.date || '日付不明');
  return `[${headline}｜${date}](/articles/${id})`;
}

function articleUrlFromRecord(record: JsonRecord) {
  const url = text(record.article_url);
  if (url) return url;
  const id = text(record.article_id || record.id);
  return id ? `/articles/${id}` : '';
}

function evidenceSources(answer: JsonRecord, relatedArticles: unknown[]) {
  const sources = [
    ...asArray(answer.evidence_matrix),
    ...asArray(answer.evidence),
    ...asArray(answer.cards),
    ...asArray(answer.article_lookup),
    ...relatedArticles
  ].filter(isRecord);

  const seen = new Set<string>();
  const unique: JsonRecord[] = [];
  for (const source of sources) {
    const id = text(source.article_id || source.id || source.article_url || source.article_link || JSON.stringify(source).slice(0, 120));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(source);
  }
  return unique;
}

function normalizeEvidenceItem(item: JsonRecord, index: number) {
  const id = text(item.article_id || item.id);
  const link = articleLinkFromRecord(item);
  return {
    claim: text(item.claim || item.theme || item.title || item.reason || item.note) || `根拠候補 ${index + 1}`,
    article_id: id,
    headline: text(item.headline || item.title || '記事'),
    article_date: text(item.article_date || item.date || '日付不明'),
    article_url: articleUrlFromRecord(item),
    article_link: link,
    evidence_excerpt_or_fact: text(item.evidence_excerpt_or_fact || item.evidence_excerpt || item.excerpt || item.reason || item.note || item.ocr_text || '根拠抜粋未取得').slice(0, 500),
    evidence_strength: text(item.evidence_strength || item.strength || item.confidence || 'B'),
    limitation: text(item.limitation || '記事本文から確認できる範囲に限定。生活者心理は仮説として扱う。'),
    what_can_be_said: text(item.what_can_be_said || '当該記事は分析上の根拠候補として利用できる。'),
    what_cannot_be_said: text(item.what_cannot_be_said || 'この記事単独では生活者全体の傾向とは断定できない。'),
    research_need: text(item.research_need || '他記事・追加調査で再現性を確認する必要がある。')
  };
}

function evidenceFallback(answer: JsonRecord, relatedArticles: unknown[]) {
  return evidenceSources(answer, relatedArticles).slice(0, 8).map(normalizeEvidenceItem);
}

function normalizeEvidenceMatrix(answer: JsonRecord, relatedArticles: unknown[]) {
  const current = asArray(answer.evidence_matrix).filter(isRecord).map(normalizeEvidenceItem);
  const hasEnough = current.length >= 3 && current.some((item) => hasClickableArticleLink(text(item.article_link)));
  if (hasEnough) return current;

  const fallback = evidenceFallback(answer, relatedArticles);
  const merged = [...current];
  const seen = new Set(current.map((item) => text(item.article_id || item.article_link)).filter(Boolean));
  for (const item of fallback) {
    const key = text(item.article_id || item.article_link);
    if (key && seen.has(key)) continue;
    merged.push(item);
    if (key) seen.add(key);
    if (merged.length >= 8) break;
  }
  return merged.length ? merged : fallback;
}

function evidenceLinksMarkdown(answer: JsonRecord) {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord).slice(0, 8);
  const lines = evidence
    .map((item, index) => {
      const link = articleLinkFromRecord(item);
      if (!link) return '';
      const claim = text(item.claim || `根拠候補 ${index + 1}`);
      const fact = text(item.evidence_excerpt_or_fact || item.what_can_be_said || '').slice(0, 180);
      const strength = text(item.evidence_strength || 'B');
      return `- ${claim}：${link}（根拠強度${strength}）${fact ? ` — ${fact}` : ''}`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return ['## 10.5 根拠記事リンク', ...lines].join('\n');
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
      evidence_gap: '生活者発話、購買継続、比較対象、反例データが不足している可能性。',
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

function negativeSpaceFallback(answer: JsonRecord) {
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  return [{
    expected_but_weak_or_absent_theme: '生活者本人の発話・継続行動・不満の直接証拠',
    why_absence_matters: 'MJ記事は企業施策・商品投入・売場側の情報が多く、生活者心理を直接観察しているとは限らない。',
    what_to_check_next: '該当テーマについて、実購買者・非購買者の発話、継続率、比較対象カテゴリの反例を確認する。',
    coverage_context: text(coverage.coverage_note)
  }];
}

function confidenceRubricFallback(answer: JsonRecord) {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord).slice(0, 5);
  if (!evidence.length) {
    return [{
      claim: '主要結論全体',
      confidence: 'C',
      reason_for_confidence: '記事群から方向性は読めるが、根拠マトリクスが弱い。',
      reason_for_uncertainty: '直接の生活者発話・反例・継続性の確認が不足。'
    }];
  }
  return evidence.map((item) => ({
    claim: text(item.claim || '根拠付き主張'),
    confidence: text(item.evidence_strength || 'B'),
    reason_for_confidence: text(item.what_can_be_said || item.evidence_excerpt_or_fact || '記事事実に基づく。'),
    reason_for_uncertainty: text(item.what_cannot_be_said || item.limitation || 'この記事単独では生活者全体の傾向とは断定できない。')
  }));
}

function researchNeedsFallback(answer: JsonRecord) {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord).slice(0, 5);
  if (!evidence.length) {
    return [{
      question: '記事群から見える生活者変化は、実際の生活者発話・購買継続・非購買理由で支持されるか。',
      why_it_matters: '記事は企業施策や市場側の動きに偏りやすく、生活者インサイトとして断定するには追加検証が必要。',
      needed_data: '生活者インタビュー、購買・利用継続データ、反例カテゴリ、非利用者の理由。',
      method_hint: 'N1深掘り、投影法、生活文脈インタビュー、定量共感検証。',
      priority: 'high'
    }];
  }

  return evidence.map((item, index) => ({
    question: `「${text(item.claim || `根拠候補 ${index + 1}`)}」は生活者側の行動・心理として再現性があるか。`,
    why_it_matters: text(item.what_cannot_be_said || item.limitation || '記事単独では生活者全体の傾向とは断定できないため。'),
    needed_data: '生活者発話、購買・利用継続、非利用理由、カテゴリ横断の反例。',
    method_hint: '該当記事を刺激材にしたN1深掘りと、共感・行動意向の定量確認。',
    evidence_article_link: articleLinkFromRecord(item),
    priority: index < 2 ? 'high' : 'medium'
  }));
}

function researchNeedsMarkdown(answer: JsonRecord) {
  const needs = asArray(answer.research_needs).filter(isRecord).slice(0, 6);
  if (!needs.length) return '';
  return [
    '## 10.7 調査論点補修',
    ...needs.map((need, index) => {
      const question = text(need.question || need.theme || `調査論点 ${index + 1}`);
      const why = text(need.why_it_matters || need.reason || '追加検証が必要。');
      const method = text(need.method_hint || need.needed_data || 'N1深掘りと定量検証。');
      const link = text(need.evidence_article_link);
      return `- ${question}${link ? `：${link}` : ''}\n  - 理由: ${why}\n  - 方法: ${method}`;
    })
  ].join('\n');
}

function coverageBlock(answer: JsonRecord, result: JsonRecord, relatedArticles: unknown[]) {
  const source = isRecord(answer.source_coverage) ? answer.source_coverage : isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {};
  const retrieved = firstNumber(answer.related_article_count, source.article_count, relatedArticles.length) ?? relatedArticles.length;
  const scanned = firstNumber(answer.article_count_scanned, source.scanned_article_count, source.article_count, retrieved) ?? retrieved;
  const final = firstNumber(answer.article_count_for_report, source.final_article_count, source.report_article_count, asArray(answer.selected_article_ids).length) ?? null;
  const rollupCount = firstNumber(source.monthly_rollup_source_article_count, answer.monthly_rollup_source_article_count) ?? null;
  const total = firstNumber(source.monthly_rollup_total_article_count, source.active_article_count, source.article_count, retrieved) ?? retrieved;
  const scanModel = text(answer.scan_model || result.scan_model || source.scan_model || 'unknown');
  const mode = text(answer.retrieval_mode || result.retrieval_mode || source.retrieval_mode);
  const scanEnabled = Boolean(answer.scan_enabled || result.scan_enabled || mode);

  return {
    article_count: retrieved,
    full_corpus_article_count: total,
    monthly_rollup_source_article_count: rollupCount,
    scanned_article_count: scanned,
    final_article_count: final,
    scan_model: scanModel,
    scan_enabled: scanEnabled,
    retrieval_mode: mode,
    coverage_note: scanEnabled
      ? `全件カバレッジは${total}件、スキャンは${scanned}件、月別rollup対象は${rollupCount ?? '-'}件です。最終投入${final ?? '複数'}件は根拠確認用であり、直接該当率ではありません。全記事本文をそのまま単一プロンプトへ丸投げする設計ではありません。`
      : `対象記事${retrieved}件から分析しています。`,
    limitation: '最終レポートは選抜記事と月別rollupに基づく統合分析です。スキャン外・選抜外の記事に反例がある可能性は、調査論点として残します。'
  };
}

function buildChecks(answer: JsonRecord, answerText: string) {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord);
  const evidenceCount = evidence.length;
  const evidenceLinkCount = evidence.filter((item) => hasClickableArticleLink(text(item.article_link))).length;
  const refutationCount = asArray(answer.refutation_audit).length;
  const researchNeedCount = asArray(answer.research_needs).length;
  const linkCount = countClickableArticleLinks(answerText);
  const sourceCoverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  const coverageComplete = Boolean(sourceCoverage.monthly_rollup_coverage_complete || answer.monthly_rollup_coverage_complete);
  const provisional = Boolean(sourceCoverage.analysis_is_provisional || answer.analysis_is_provisional);
  const fallbackRollup = text(sourceCoverage.scan_model || answer.scan_model).includes('fallback') || text(answer.generation_warning).includes('fallback');

  return [
    { key: 'answer_text', passed: answerText.length > 120, note: '本文が十分に生成されているか' },
    { key: 'coverage', passed: isRecord(answer.coverage_diagnosis) || isRecord(answer.source_coverage), note: '取得・スキャン・最終投入の範囲が見えるか' },
    { key: 'coverage_complete_or_flagged', passed: coverageComplete || provisional, note: '全件カバレッジが完全、または暫定扱いが明示されているか' },
    { key: 'evidence_matrix', passed: evidenceCount >= 3 && evidenceLinkCount >= 3, note: '主要主張を支えるクリック可能な根拠マトリクスが十分に存在するか' },
    { key: 'refutation_audit', passed: refutationCount >= 1, note: '反証・別解釈・棄却条件が存在するか' },
    { key: 'research_needs', passed: researchNeedCount >= 1, note: '調査論点が存在するか' },
    { key: 'negative_space', passed: asArray(answer.negative_space).length >= 1, note: '見えていない論点・欠落証拠が明示されているか' },
    { key: 'confidence_rubric', passed: asArray(answer.confidence_rubric).length >= 1, note: '主張ごとの信頼度と不確実性が明示されているか' },
    { key: 'article_links', passed: hasClickableArticleLink(answerText), note: '本文内にクリック可能な記事リンクがあるか' },
    { key: 'multiple_links', passed: linkCount >= 3, note: '本文内の根拠リンクが少なすぎないか' },
    { key: 'fallback_awareness', passed: !fallbackRollup || answerText.includes('暫定') || answerText.includes('抽出型') || answerText.includes('限界'), note: 'fallback利用時に品質限界が明示されているか' }
  ] as QualityCheck[];
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

function qualityAuditText(checks: QualityCheck[]) {
  const failed = checks.filter((check) => !check.passed);
  if (!failed.length) return '';
  return [
    '## 12. 分析品質監査',
    `不足検知: ${failed.length}件`,
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

  answer.evidence_matrix = normalizeEvidenceMatrix(answer, relatedArticles);
  if (!asArray(answer.refutation_audit).length) answer.refutation_audit = refutationFallback(answer);
  if (!asArray(answer.negative_space).length) answer.negative_space = negativeSpaceFallback(answer);
  if (!asArray(answer.confidence_rubric).length) answer.confidence_rubric = confidenceRubricFallback(answer);
  if (!asArray(answer.research_needs).length) answer.research_needs = researchNeedsFallback(answer);

  const coverage = isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {};
  const source = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  body = body.replace(/直接該当\s*[:：]\s*\d+件/g, `根拠確認用記事: ${text(coverage.final_article_count || source.final_article_count) || '-'}件（全件カバレッジではない）`);

  const systemCoverageText = [
    '## 0.0 システムカバレッジ（自動検証）',
    `全件カバレッジ: ${text(coverage.full_corpus_article_count || source.full_corpus_article_count || source.article_count) || '-'}件`,
    `月別rollup対象記事数: ${text(coverage.monthly_rollup_source_article_count || source.monthly_rollup_source_article_count) || '-'}件`,
    `スキャン記事数: ${text(coverage.scanned_article_count || source.scanned_article_count) || '-'}`,
    `根拠確認用記事数: ${text(coverage.final_article_count || source.final_article_count) || '-'}件`,
    `注記: 根拠確認用記事数は、直接該当率ではありません。全体分析の母集団は月別rollupと全件スキャンです。`,
    `選抜方式: ${text(coverage.coverage_note || source.coverage_note) || '-'}`,
    ''
  ].join('\n');

  if (!body.includes('## 0.0 システムカバレッジ')) {
    body = `${systemCoverageText}${body}`;
  }

  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) {
    body = `${body}\n\n${evidenceLinks}`.trim();
  }

  const researchNeeds = researchNeedsMarkdown(answer);
  if (researchNeeds && !body.includes('## 10.7 調査論点補修')) {
    body = `${body}\n\n${researchNeeds}`.trim();
  }

  const checks = buildChecks(answer, body);
  const appendix = qualityAppendix(checks);
  if (appendix && !body.includes('## 11. 品質ゲート補足')) body = `${body}\n\n${appendix}`.trim();
  const audit = qualityAuditText(checks);
  if (audit && !body.includes('## 12. 分析品質監査')) body = `${body}\n\n${audit}`.trim();

  answer.answer_text = body || systemCoverageText.trim();
  answer.quality_gate = {
    status: checks.every((check) => check.passed) ? 'passed' : 'needs_review',
    checks,
    failed_checks: checks.filter((check) => !check.passed).map((check) => check.key),
    note: 'この品質ゲートは後処理バリデータです。独立LLMによる別人格監査ではありません。'
  };

  return { ...result, answer } as T;
}
