type JsonRecord = Record<string, unknown>;

type QualityCheck = {
  key: string;
  passed: boolean;
  note: string;
};

type QualityGate = {
  status: 'passed' | 'needs_review';
  checks: QualityCheck[];
  failed_checks: string[];
  validation_mode: 'raw_before_enrichment';
  version: 'formal_gate_v2';
  note: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function bool(value: unknown) {
  if (typeof value === 'boolean') return value;
  const normalized = text(value).toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(normalized);
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
  const existing = text(record.article_url);
  if (existing.startsWith('/articles/')) return existing;
  const id = text(record.article_id || record.id);
  return id ? `/articles/${id}` : '';
}

function moveCoverageToEnd(value: string) {
  let body = value || '';
  body = body.replace(/直接該当記事数\s*[:：]\s*(\d+)件/g, 'LLM個別本文投入記事数: $1件');
  body = body.replace(/直接該当\s*[:：]\s*(\d+)件/g, 'LLM個別本文投入記事数: $1件');
  body = body.replaceAll('直接該当率ではありません', '全件カバレッジとは別の入力制御です');
  const marker = '## 0.0 システムカバレッジ';
  if (!body.startsWith(marker)) return body.trim();
  const conclusions = ['## 1. 結論', '## 1 結論', '## 結論', '# 結論'];
  const indexes = conclusions.map((item) => body.indexOf(item)).filter((index) => index > 0);
  if (!indexes.length) return body.trim();
  const conclusionIndex = Math.min(...indexes);
  const coverage = body.slice(0, conclusionIndex).trim();
  const main = body.slice(conclusionIndex).trim();
  if (!coverage || main.includes('## 99. カバレッジ・システム情報')) return main || body.trim();
  return `${main}\n\n## 99. カバレッジ・システム情報\n${coverage}`.trim();
}

function evidenceSources(answer: JsonRecord, relatedArticles: unknown[]) {
  return [
    ...asArray(answer.evidence_matrix),
    ...asArray(answer.evidence),
    ...asArray(answer.cards),
    ...asArray(answer.article_lookup),
    ...relatedArticles
  ].filter(isRecord);
}

function normalizeEvidenceItem(item: JsonRecord, index: number, syntheticRepair = false) {
  const id = text(item.article_id || item.id);
  const fact = text(
    item.evidence_excerpt_or_fact
    || item.evidence_excerpt
    || item.observed_fact
    || item.excerpt
    || item.reason
    || item.note
    || item.ocr_text
  ).slice(0, 500);
  return {
    claim: text(item.claim || item.theme || item.title || item.reason || item.note) || `根拠候補 ${index + 1}`,
    article_id: id,
    headline: text(item.headline || item.title || '記事'),
    article_date: text(item.article_date || item.date || '日付不明'),
    article_url: articleUrlFromRecord(item),
    article_link: articleLinkFromRecord(item),
    evidence_excerpt_or_fact: fact || '根拠抜粋未取得',
    evidence_strength: text(item.evidence_strength || item.strength || item.confidence || 'C'),
    theme_id: text(item.theme_id),
    evidence_type: text(item.evidence_type),
    batch_index: firstNumber(item.batch_index),
    limitation: text(item.limitation || '記事本文から確認できる範囲に限定。生活者心理は仮説として扱う。'),
    what_can_be_said: text(item.what_can_be_said || '当該記事で観察できる事実に限定する。'),
    what_cannot_be_said: text(item.what_cannot_be_said || 'この記事単独では生活者全体の傾向とは断定できない。'),
    research_need: text(item.research_need || '他記事・追加調査で再現性を確認する必要がある。'),
    ...(syntheticRepair ? { synthetic_repair: true } : {})
  };
}

function evidenceFallback(answer: JsonRecord, relatedArticles: unknown[]) {
  const seen = new Set<string>();
  const rows: JsonRecord[] = [];
  for (const source of evidenceSources(answer, relatedArticles)) {
    const id = text(source.article_id || source.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push(normalizeEvidenceItem(source, rows.length, true));
    if (rows.length >= 8) break;
  }
  return rows;
}

function normalizeEvidenceMatrix(answer: JsonRecord, relatedArticles: unknown[]) {
  const current = asArray(answer.evidence_matrix).filter(isRecord).map((item, index) => normalizeEvidenceItem(item, index));
  if (current.length >= 3) return current;
  const merged: JsonRecord[] = [...current];
  const seen = new Set(current.map((item) => text(item.article_id)).filter(Boolean));
  for (const item of evidenceFallback(answer, relatedArticles)) {
    const id = text(item.article_id);
    if (!id || seen.has(id)) continue;
    merged.push(item);
    seen.add(id);
    if (merged.length >= 8) break;
  }
  return merged;
}

function refutationFallback(answer: JsonRecord) {
  const claims = [...asArray(answer.major_trends), ...asArray(answer.explanatory_hypotheses), ...asArray(answer.cross_article_insights)]
    .filter(isRecord)
    .slice(0, 5);
  if (!claims.length) {
    return [{
      target_claim: '主要主張全体',
      possible_counterargument: '企業施策・商品投入中心の記事を生活者変化として読み替えすぎている可能性がある。',
      evidence_gap: '生活者発話、購買継続、比較対象、反例データが不足している可能性。',
      downgrade_or_revision: '断定ではなく、調査で検証すべき仮説として扱う。',
      falsification_condition: '追加調査で該当行動が一部カテゴリや一時的話題に限定されると確認された場合。',
      synthetic_repair: true
    }];
  }
  return claims.map((claim, index) => ({
    target_claim: text(claim.claim || claim.trend || claim.hypothesis || claim.title || `主要主張 ${index + 1}`),
    possible_counterargument: text(claim.alternative_read) || '企業施策やカテゴリ事情を、生活者変化として読み替えすぎている可能性がある。',
    evidence_gap: '記事根拠だけでは、行動の持続性・広がり・心理要因までは断定できない。',
    downgrade_or_revision: '根拠が直接的でない部分は仮説として扱う。',
    falsification_condition: '反例記事、購買継続率、生活者発話、カテゴリ外比較で支持されない場合。',
    synthetic_repair: true
  }));
}

function negativeSpaceFallback(answer: JsonRecord) {
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  return [{
    expected_but_weak_or_absent_theme: '生活者本人の発話・継続行動・不満の直接証拠',
    why_absence_matters: '記事は企業施策・商品投入・売場側の情報に偏る可能性がある。',
    what_to_check_next: '実購買者・非購買者の発話、継続率、比較対象カテゴリの反例を確認する。',
    coverage_context: text(coverage.coverage_note),
    synthetic_repair: true
  }];
}

function confidenceRubricFallback(answer: JsonRecord) {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord).slice(0, 5);
  if (!evidence.length) {
    return [{
      claim: '主要結論全体',
      confidence: 'C',
      reason_for_confidence: '記事群から方向性は読める。',
      reason_for_uncertainty: '直接の生活者発話・反例・継続性の確認が不足。',
      synthetic_repair: true
    }];
  }
  return evidence.map((item) => ({
    claim: text(item.claim || '根拠付き主張'),
    confidence: text(item.evidence_strength || 'C'),
    reason_for_confidence: text(item.what_can_be_said || item.evidence_excerpt_or_fact || '記事事実に基づく。'),
    reason_for_uncertainty: text(item.what_cannot_be_said || item.limitation || 'この記事単独では全体傾向とは断定できない。'),
    synthetic_repair: true
  }));
}

function researchNeedsFallback(answer: JsonRecord) {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord).slice(0, 5);
  if (!evidence.length) {
    return [{
      question: '記事群から見える生活者変化は、実際の生活者発話・購買継続・非購買理由で支持されるか。',
      why_it_matters: '記事だけでは生活者インサイトとして断定できない。',
      needed_data: '生活者インタビュー、購買・利用継続データ、反例カテゴリ、非利用者の理由。',
      method_hint: 'N1深掘りと定量検証。',
      priority: 'high',
      synthetic_repair: true
    }];
  }
  return evidence.map((item, index) => ({
    question: `「${text(item.claim || `根拠候補 ${index + 1}`)}」は生活者側の行動・心理として再現性があるか。`,
    why_it_matters: text(item.what_cannot_be_said || item.limitation || '記事単独では全体傾向とは断定できないため。'),
    needed_data: '生活者発話、購買・利用継続、非利用理由、カテゴリ横断の反例。',
    method_hint: '該当記事を刺激材にしたN1深掘りと定量確認。',
    evidence_article_link: articleLinkFromRecord(item),
    priority: index < 2 ? 'high' : 'medium',
    synthetic_repair: true
  }));
}

function rawEvidenceValid(item: JsonRecord) {
  const id = text(item.article_id || item.id);
  const claim = text(item.claim || item.theme || item.title);
  const fact = text(item.evidence_excerpt_or_fact || item.evidence_excerpt || item.observed_fact || item.excerpt);
  const whatCanBeSaid = text(item.what_can_be_said);
  const malformed = /\[object Object\]|\[object Undefined\]|^undefined$|^null$/i;
  return Boolean(
    id
    && claim.length >= 8
    && fact.length >= 20
    && whatCanBeSaid.length >= 10
    && !malformed.test(claim)
    && !malformed.test(fact)
    && !malformed.test(whatCanBeSaid)
    && !bool(item.synthetic_repair)
  );
}

function existingRawGate(answer: JsonRecord): QualityGate | null {
  const gate = isRecord(answer.raw_quality_gate) ? answer.raw_quality_gate : null;
  if (!gate || gate.version !== 'formal_gate_v2' || gate.validation_mode !== 'raw_before_enrichment') return null;
  const checks = asArray(gate.checks).filter(isRecord).map((check) => ({
    key: text(check.key),
    passed: bool(check.passed),
    note: text(check.note)
  })).filter((check) => check.key);
  return {
    status: gate.status === 'passed' ? 'passed' : 'needs_review',
    checks,
    failed_checks: asArray(gate.failed_checks).map(text).filter(Boolean),
    validation_mode: 'raw_before_enrichment',
    version: 'formal_gate_v2',
    note: text(gate.note) || '正式判定は表示補修前の生出力に対して実施。'
  };
}

function buildRawQualityGate(answer: JsonRecord, answerText: string): QualityGate {
  const evidence = asArray(answer.evidence_matrix).filter(isRecord);
  const validEvidence = evidence.filter(rawEvidenceValid);
  const distinctEvidenceIds = new Set(validEvidence.map((item) => text(item.article_id || item.id))).size;
  const sourceCoverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  const coverageDiagnosis = isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {};
  const provisional = bool(
    answer.analysis_is_provisional
    ?? sourceCoverage.analysis_is_provisional
    ?? coverageDiagnosis.analysis_is_provisional
  );
  const fullCorpusGate = text(answer.full_corpus_gate || sourceCoverage.full_corpus_gate);
  const scanModel = text(answer.scan_model || sourceCoverage.scan_model).toLowerCase();
  const generationWarning = text(answer.generation_warning).toLowerCase();
  const extractiveFallbackRollup = scanModel.includes('extractive_fallback')
    || generationWarning.includes('extractive_fallback');
  const emergencyFallback = generationWarning.includes('emergency_fallback')
    || generationWarning.includes('openai_api_key missing');
  const rawLinkCount = countClickableArticleLinks(answerText);

  const checks: QualityCheck[] = [
    { key: 'answer_text', passed: answerText.length > 120, note: '生出力本文が十分に生成されているか' },
    { key: 'coverage', passed: isRecord(answer.coverage_diagnosis) || isRecord(answer.source_coverage), note: '取得・スキャン・最終投入の範囲が生出力にあるか' },
    { key: 'full_corpus_gate', passed: !fullCorpusGate || fullCorpusGate === 'passed', note: '正式な全件/カテゴリ分析でfull_corpus_gateがpassedか' },
    { key: 'not_provisional', passed: !provisional, note: '暫定分析を正式扱いしていないか' },
    { key: 'no_emergency_fallback', passed: !emergencyFallback, note: '緊急fallbackを正式品質として扱っていないか' },
    { key: 'no_extract_fallback_rollup', passed: !extractiveFallbackRollup, note: '抽出型fallback rollupを正式入力として扱っていないか' },
    { key: 'raw_evidence_matrix', passed: validEvidence.length >= 5 && distinctEvidenceIds >= 5, note: '表示補修前に5件以上の具体的かつ文字列整合した根拠があるか' },
    { key: 'raw_refutation_audit', passed: asArray(answer.refutation_audit).filter(isRecord).length >= 1, note: '表示補修前に反証・棄却条件があるか' },
    { key: 'raw_research_needs', passed: asArray(answer.research_needs).filter(isRecord).length >= 1, note: '表示補修前に調査論点があるか' },
    { key: 'raw_negative_space', passed: asArray(answer.negative_space).filter(isRecord).length >= 1, note: '表示補修前に欠落証拠があるか' },
    { key: 'raw_confidence_rubric', passed: asArray(answer.confidence_rubric).filter(isRecord).length >= 1, note: '表示補修前に信頼度と不確実性があるか' },
    { key: 'raw_article_links', passed: rawLinkCount >= 3, note: '生出力本文に追跡可能な記事リンクが3件以上あるか' }
  ];
  const failed = checks.filter((check) => !check.passed).map((check) => check.key);
  return {
    status: failed.length ? 'needs_review' : 'passed',
    checks,
    failed_checks: failed,
    validation_mode: 'raw_before_enrichment',
    version: 'formal_gate_v2',
    note: '正式判定は表示補修前の生出力に対して実施し、自動補修項目は合格根拠に含めません。'
  };
}

function coverageBlock(answer: JsonRecord, result: JsonRecord, relatedArticles: unknown[]) {
  const source = isRecord(answer.source_coverage)
    ? answer.source_coverage
    : isRecord(answer.coverage_diagnosis)
      ? answer.coverage_diagnosis
      : {};
  const retrieved = firstNumber(answer.related_article_count, source.article_count, relatedArticles.length) ?? relatedArticles.length;
  const scanned = firstNumber(answer.article_count_scanned, source.scanned_article_count, source.article_count, retrieved) ?? retrieved;
  const finalCount = firstNumber(answer.article_count_for_report, source.final_article_count, asArray(answer.selected_article_ids).length);
  const total = firstNumber(source.full_corpus_article_count, source.active_article_count, source.article_count, retrieved) ?? retrieved;
  return {
    article_count: retrieved,
    full_corpus_article_count: total,
    scanned_article_count: scanned,
    final_article_count: finalCount,
    scan_model: text(answer.scan_model || result.scan_model || source.scan_model || 'unknown'),
    scan_enabled: bool(answer.scan_enabled || result.scan_enabled || source.scan_enabled),
    retrieval_mode: text(answer.retrieval_mode || result.retrieval_mode || source.retrieval_mode),
    full_corpus_gate: text(answer.full_corpus_gate || source.full_corpus_gate),
    analysis_is_provisional: bool(answer.analysis_is_provisional ?? source.analysis_is_provisional),
    coverage_note: text(source.coverage_note) || `全件カバレッジ${total}件、スキャン${scanned}件、LLM個別本文投入${finalCount ?? '-'}件。`,
    limitation: text(source.limitation) || '選抜外の記事に反例がある可能性を調査論点として残す。'
  };
}

function evidenceLinksMarkdown(answer: JsonRecord) {
  const lines = asArray(answer.evidence_matrix).filter(isRecord).slice(0, 8).map((item, index) => {
    const link = articleLinkFromRecord(item);
    if (!link) return '';
    const claim = text(item.claim || `根拠候補 ${index + 1}`);
    const fact = text(item.evidence_excerpt_or_fact || item.what_can_be_said).slice(0, 180);
    const repair = bool(item.synthetic_repair) ? '・表示補修' : '';
    return `- ${claim}：${link}（根拠強度${text(item.evidence_strength || 'C')}${repair}）${fact ? ` — ${fact}` : ''}`;
  }).filter(Boolean);
  return lines.length ? ['## 10.5 根拠記事リンク', ...lines].join('\n') : '';
}

function qualityAppendix(gate: QualityGate) {
  if (gate.status === 'passed') return '';
  return [
    '## 11. 品質ゲート補足',
    '以下は表示補修前の生出力で不足した項目です。自動補修しても正式判定は変わりません。',
    ...gate.checks.filter((check) => !check.passed).map((check) => `- ${check.key}: ${check.note}`)
  ].join('\n');
}

export function enhanceChatAnalysisResult<T>(result: T): T {
  if (!isRecord(result)) return result;
  const answer = isRecord(result.answer) ? { ...result.answer } : {};
  const relatedArticles = asArray(result.related_articles);
  const rawAnswerText = text(answer.answer_text);
  const rawGate = buildRawQualityGate(answer, rawAnswerText);

  answer.raw_quality_gate = rawGate;
  answer.quality_gate = rawGate;
  answer.formal_gate_version = 'formal_gate_v2';

  answer.coverage_diagnosis = {
    ...coverageBlock(answer, result, relatedArticles),
    ...(isRecord(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {})
  };
  answer.source_coverage = {
    ...coverageBlock(answer, result, relatedArticles),
    ...(isRecord(answer.source_coverage) ? answer.source_coverage : {})
  };

  answer.evidence_matrix = normalizeEvidenceMatrix(answer, relatedArticles);
  if (!asArray(answer.refutation_audit).length) answer.refutation_audit = refutationFallback(answer);
  if (!asArray(answer.negative_space).length) answer.negative_space = negativeSpaceFallback(answer);
  if (!asArray(answer.confidence_rubric).length) answer.confidence_rubric = confidenceRubricFallback(answer);
  if (!asArray(answer.research_needs).length) answer.research_needs = researchNeedsFallback(answer);

  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
  let body = hierarchicalReport ? rawAnswerText.trim() : moveCoverageToEnd(rawAnswerText);
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  if (!hierarchicalReport && !body.includes('## 99. カバレッジ・システム情報')) {
    body = `${body}\n\n${[
      '## 99. カバレッジ・システム情報',
      `全件カバレッジ: ${text(coverage.full_corpus_article_count || coverage.article_count) || '-'}件`,
      `月別rollup対象記事数: ${text(coverage.monthly_rollup_source_article_count) || '-'}件`,
      `スキャン記事数: ${text(coverage.scanned_article_count) || '-'}件`,
      `LLM個別本文投入記事数: ${text(coverage.final_article_count) || '-'}件`,
      `暫定判定: ${bool(coverage.analysis_is_provisional) ? 'はい' : 'いいえ'}`,
      `選抜方式: ${text(coverage.coverage_note) || '-'}`
    ].join('\n')}`.trim();
  }

  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (!hierarchicalReport && evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) body = `${body}\n\n${evidenceLinks}`.trim();
  const appendix = qualityAppendix(rawGate);
  if (!hierarchicalReport && appendix && !body.includes('## 11. 品質ゲート補足')) body = `${body}\n\n${appendix}`.trim();

  answer.answer_text = body;
  answer.display_enrichment = {
    evidence_repaired: asArray(answer.evidence_matrix).filter(isRecord).some((item) => bool(item.synthetic_repair)),
    refutation_repaired: asArray(answer.refutation_audit).filter(isRecord).some((item) => bool(item.synthetic_repair)),
    negative_space_repaired: asArray(answer.negative_space).filter(isRecord).some((item) => bool(item.synthetic_repair)),
    confidence_repaired: asArray(answer.confidence_rubric).filter(isRecord).some((item) => bool(item.synthetic_repair)),
    research_needs_repaired: asArray(answer.research_needs).filter(isRecord).some((item) => bool(item.synthetic_repair))
  };
  return { ...result, answer } as T;
}
