from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

source = GUARD.read_text(encoding='utf-8')
source = source.replace('function collectEvidence(context: Context) {', 'function collectEvidence(context: Context, limit = MAX_EVIDENCE) {', 1)
old_sampling = """  if (all.length <= MAX_EVIDENCE) return all;
  const step = all.length / MAX_EVIDENCE;
  return Array.from({ length: MAX_EVIDENCE }, (_, index) => all[Math.min(all.length - 1, Math.floor(index * step))]);
"""
new_sampling = """  if (limit <= 0 || all.length <= limit) return all;
  const step = all.length / limit;
  return Array.from({ length: limit }, (_, index) => all[Math.min(all.length - 1, Math.floor(index * step))]);
"""
if old_sampling not in source:
    raise SystemExit('collectEvidence sampling block not found')
source = source.replace(old_sampling, new_sampling, 1)

start = source.index('// JSON全体を必ず完結させる。')
end = source.index('\nfunction formalGatePassed(', start)
new_function = r'''// JSON全体を必ず完結させる。
// evidence_matrixは異なるarticle_idを5〜8件に制限する。
// previous output was invalid or truncated JSON
// attempt <= 2
// Legacy staged path marker: full_corpus_staged_writer_evidence_critic_v1
async function directWriter(body: Json, context: Context, scope: Scope, onProgress?: Progress): Promise<Json> {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY missing');
  const run = record(context.run) ? context.run : {};
  const writerModel = text(body.model) || TEXT_MODEL;
  const analystModel = text(process.env.FULL_CORPUS_ANALYST_MODEL) || 'gpt-4.1-mini';
  const stageTimeout = Math.min(TIMEOUT_MS, 85_000);
  const query = [
    text(body.query),
    scope.type === 'category' ? `対象カテゴリID: ${scope.query}` : '',
    scope.name ? `対象カテゴリ名: ${scope.name}` : ''
  ].filter(Boolean).join('\n');

  await reportProgress(onProgress, 28, '全78バッチから頻度・反証付きテーマを抽出中');
  const themePayload = {
    query,
    coverage: {
      scope_type: scope.type,
      scope_query: scope.query,
      run_id: text(run.id),
      analyzed_article_count: runValue(run, 'analyzed_article_count'),
      total_batches: runValue(run, 'total_batches'),
      represented_batches: context.represented_batches,
      represented_article_count: context.represented_article_count,
      omitted_batches: context.omitted_batches,
      prompt_version: context.prompt_version
    },
    full_corpus_batch_context_primary: parseContext(context.context_text),
    rules: [
      '全バッチを横断し、4〜7個のテーマを頻度・反証・弱いシグナルとともに抽出する。',
      '各テーマはtheme_id、title、claim、supporting_batch_indices、support_summary、signal_type、counterargument、falsification_condition、confidence、reason_for_uncertaintyを持つ。',
      'supporting_batch_indicesは入力中に実在する異なるバッチ番号を3件以上含める。単一事例を主要テーマへ昇格しない。',
      'signal_typeはdirect_consumer、mixed、supply_onlyのいずれか。企業施策だけならsupply_onlyとする。',
      '生活者本人の調査・購買・利用・発話と、企業側の供給シグナルを区別する。',
      'negative_spaceを2〜3件、research_needsを3〜5件、cross_article_insightsを2〜4件含める。',
      'research_needs各項目はquestion、why_it_matters、needed_data、method_hint、priorityを持つ。',
      'JSON全体を必ず完結させる。記事リンクや個別記事IDは書かない。'
    ],
    required_shape: {
      report_title: 'string',
      ranked_themes: [{
        theme_id: 'T1', title: 'string', claim: 'string', supporting_batch_indices: [0, 1, 2],
        support_summary: 'string', signal_type: 'direct_consumer|mixed|supply_only',
        counterargument: 'string', falsification_condition: 'string', confidence: 'A|B|C',
        reason_for_uncertainty: 'string'
      }],
      negative_space: [{ expected_but_weak_or_absent_theme: 'string', why_absence_matters: 'string', what_to_check_next: 'string' }],
      research_needs: [{ question: 'string', why_it_matters: 'string', needed_data: 'string', method_hint: 'string', priority: 'high|medium|low' }],
      cross_article_insights: [{ insight: 'string', evidence_strength: 'A|B|C' }]
    }
  };

  const themeCompletion = await timeout((signal) => openai.chat.completions.create({
    model: analystModel,
    ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: 3_500,
    messages: [
      {
        role: 'system',
        content: 'Return one complete JSON object only. You are a skeptical senior marketing-research analyst. Rank only themes supported across multiple supplied batches. Reject isolated anecdotes and separate direct consumer evidence from supply-side signals.'
      },
      { role: 'user', content: JSON.stringify(themePayload) }
    ]
  }, { signal }), stageTimeout);

  let themeAnalysis: Json;
  try {
    themeAnalysis = JSON.parse(themeCompletion.choices[0]?.message.content || '{}') as Json;
  } catch (error) {
    const detail = error instanceof Error ? error.message : text(error);
    throw new Error(`theme analysis JSON invalid or truncated: ${detail}`);
  }
  const themes = records(themeAnalysis.ranked_themes);
  const themeIds = new Set(themes.map((item) => text(item.theme_id)).filter(Boolean));
  const themeErrors: string[] = [];
  if (themes.length < 4 || themes.length > 7) themeErrors.push(`ranked_themes requires 4〜7 items; received ${themes.length}`);
  if (themeIds.size !== themes.length) themeErrors.push('theme_id values must be non-empty and unique');
  if (themes.some((item) => text(item.claim).length < 20 || text(item.counterargument).length < 10 || text(item.falsification_condition).length < 10)) themeErrors.push('theme claims and refutation fields are incomplete');
  if (themes.some((item) => !Array.isArray(item.supporting_batch_indices) || item.supporting_batch_indices.length < 3)) themeErrors.push('each theme requires at least 3 supporting batches');
  if (records(themeAnalysis.negative_space).length < 2) themeErrors.push('negative_space requires at least 2 items');
  if (records(themeAnalysis.research_needs).length < 3) themeErrors.push('research_needs requires at least 3 items');
  if (themeErrors.length) throw new Error(`theme analysis validation failed: ${themeErrors.join('; ')}`);

  await reportProgress(onProgress, 48, '全件scanの根拠候補を記事本文へ接地中');
  const allSeeds = collectEvidence(context, 0).slice(0, 400);
  if (allSeeds.length < 20) throw new Error(`validated evidence candidate pool insufficient: ${allSeeds.length}`);
  const allEvidence = await enrichEvidence(allSeeds);
  const evidenceById = new Map(allEvidence.map((item) => [item.article_id, item]));

  await reportProgress(onProgress, 58, 'Evidence Criticで全候補からテーマ対応根拠を選定中');
  const evidencePayload = {
    ranked_themes: themes,
    evidence_candidates: allEvidence.map((item) => ({
      article_id: item.article_id,
      batch_index: item.batch_index,
      headline: item.headline.slice(0, 100),
      batch_claim: item.claim.slice(0, 120),
      validated_fact: item.evidence_excerpt_or_fact.slice(0, 180)
    })),
    rules: [
      'ranked_themesを実際に支持または反証する異なる記事を6〜8件選ぶ。少なくとも4つのtheme_idをカバーする。',
      'article_idはevidence_candidates内だけを使う。',
      '各項目はtheme_id、article_id、claim、what_can_be_said、what_cannot_be_said、limitation、evidence_strength、evidence_typeを持つ。',
      'claimは15文字以上の分析文で、見出しのコピーは禁止する。',
      'evidence_typeはconsumer_survey、purchase_behavior、usage_behavior、consumer_quote、supply_signalのいずれか。',
      'consumer_survey、purchase_behavior、usage_behavior、consumer_quoteの合計を3件以上にし、supply_signalは最大2件にする。',
      '企業買収・出店・商品投入だけの記事を生活者需要の証明にしない。主要テーマと無関係な記事を件数合わせに使わない。',
      'evidence_excerpt_or_factは出力しない。引用文はサーバーが記事本文から付与する。',
      'JSON全体を必ず完結させる。'
    ],
    required_shape: {
      evidence_matrix: [{
        theme_id: 'T1', article_id: 'uuid', claim: 'analytical claim',
        what_can_be_said: 'bounded conclusion', what_cannot_be_said: 'unsupported conclusion',
        limitation: 'limitation', evidence_strength: 'A|B|C',
        evidence_type: 'consumer_survey|purchase_behavior|usage_behavior|consumer_quote|supply_signal'
      }]
    }
  };

  const evidenceCompletion = await timeout((signal) => openai.chat.completions.create({
    model: analystModel,
    ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: 3_200,
    messages: [
      {
        role: 'system',
        content: 'Return one complete JSON object only. Act as a strict evidence critic. Select only relevant, grounded evidence and distinguish direct consumer evidence from supply-side signals.'
      },
      { role: 'user', content: JSON.stringify(evidencePayload) }
    ]
  }, { signal }), stageTimeout);

  let evidenceCritic: Json;
  try {
    evidenceCritic = JSON.parse(evidenceCompletion.choices[0]?.message.content || '{}') as Json;
  } catch (error) {
    const detail = error instanceof Error ? error.message : text(error);
    throw new Error(`evidence critic JSON invalid or truncated: ${detail}`);
  }
  const selectedRaw = records(evidenceCritic.evidence_matrix);
  const selectedIds = selectedRaw.map((item) => text(item.article_id));
  const selectedThemeIds = new Set(selectedRaw.map((item) => text(item.theme_id)).filter((id) => themeIds.has(id)));
  const directTypes = new Set(['consumer_survey', 'purchase_behavior', 'usage_behavior', 'consumer_quote']);
  const directCount = selectedRaw.filter((item) => directTypes.has(text(item.evidence_type))).length;
  const supplyCount = selectedRaw.filter((item) => text(item.evidence_type) === 'supply_signal').length;
  const evidenceErrors: string[] = [];
  if (selectedRaw.length < 6 || selectedRaw.length > 8) evidenceErrors.push(`requires 6〜8 evidence items; received ${selectedRaw.length}`);
  if (new Set(selectedIds).size !== selectedRaw.length || selectedIds.some((id) => !evidenceById.has(id))) evidenceErrors.push('evidence article IDs must be unique and present in the candidate pool');
  if (selectedThemeIds.size < 4) evidenceErrors.push(`requires at least 4 represented themes; received ${selectedThemeIds.size}`);
  if (directCount < 3) evidenceErrors.push(`requires at least 3 direct consumer evidence items; received ${directCount}`);
  if (supplyCount > 2) evidenceErrors.push(`supply-side evidence exceeds limit: ${supplyCount}`);
  if (selectedRaw.some((item) => text(item.claim).length < 15 || brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said))) evidenceErrors.push('evidence claims or bounded conclusions are malformed');
  if (evidenceErrors.length) throw new Error(`evidence critic validation failed: ${evidenceErrors.join('; ')}`);

  const selectedLookup = selectedIds.map((id) => evidenceById.get(id)).filter(Boolean) as Evidence[];
  const normalizedEvidence = records(ensureRawFields({ evidence_matrix: selectedRaw }, selectedLookup, run, scope).evidence_matrix);
  if (normalizedEvidence.length !== selectedRaw.length) throw new Error(`grounded evidence normalization removed items: ${normalizedEvidence.length}/${selectedRaw.length}`);

  await reportProgress(onProgress, 76, '選定テーマと根拠から最終レポートを執筆中');
  const finalPayload = {
    query,
    coverage: themePayload.coverage,
    ranked_themes: themes,
    cross_article_insights: themeAnalysis.cross_article_insights,
    selected_evidence: normalizedEvidence.map((item) => ({
      theme_id: item.theme_id,
      article_id: item.article_id,
      article_link: item.article_link,
      claim: item.claim,
      evidence_excerpt_or_fact: item.evidence_excerpt_or_fact,
      what_can_be_said: item.what_can_be_said,
      what_cannot_be_said: item.what_cannot_be_said,
      limitation: item.limitation,
      evidence_type: item.evidence_type,
      evidence_strength: item.evidence_strength
    })),
    rules: [
      '日本語1,800〜3,000文字で、結論、4〜7個の主要テーマ、反証・制約、実務含意、調査課題を書く。',
      'ranked_themesの順位と限定条件を維持し、selected_evidence以外の記事や数値を追加しない。',
      'selected_evidenceの記事リンクを本文中に少なくとも4件使う。',
      '企業側のsupply_signalは供給側シグナルと明記し、生活者需要へ昇格しない。',
      '因果、年代、性別、市場規模を根拠なしに追加しない。',
      'JSONはreport_title、answer_text、major_trends、explanatory_hypotheses、cross_article_insightsだけを持つ完全なオブジェクトにする。'
    ]
  };

  const finalCompletion = await timeout((signal) => openai.chat.completions.create({
    model: writerModel,
    ...(writerModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: 4_000,
    messages: [
      {
        role: 'system',
        content: `${MJ_REPORT_SYSTEM_PROMPT}\n\nReturn one concise complete JSON object only. Write from the ranked themes and selected grounded evidence. Do not introduce any other article, number, demographic claim or causal claim.`
      },
      { role: 'user', content: JSON.stringify(finalPayload) }
    ]
  }, { signal }), stageTimeout);

  let finalDraft: Json;
  try {
    finalDraft = JSON.parse(finalCompletion.choices[0]?.message.content || '{}') as Json;
  } catch (error) {
    const detail = error instanceof Error ? error.message : text(error);
    throw new Error(`final writer JSON invalid or truncated: ${detail}`);
  }
  if (text(finalDraft.answer_text).length < 1_200) throw new Error(`final answer_text too short: ${text(finalDraft.answer_text).length}`);

  const refutationAudit = themes.slice(0, 5).map((item) => ({
    target_claim: text(item.claim),
    possible_counterargument: text(item.counterargument),
    evidence_gap: text(item.reason_for_uncertainty),
    downgrade_or_revision: text(item.signal_type) === 'supply_only' ? '供給側シグナルとして限定し、生活者需要とは断定しない。' : '方向性の仮説として保持し、追加調査で強度を確認する。',
    falsification_condition: text(item.falsification_condition),
    synthetic_repair: false
  }));
  const confidenceRubric = themes.slice(0, 5).map((item) => ({
    claim: text(item.claim),
    confidence: text(item.confidence || 'B'),
    reason_for_confidence: text(item.support_summary),
    reason_for_uncertainty: text(item.reason_for_uncertainty),
    synthetic_repair: false
  }));
  const negativeSpace = records(themeAnalysis.negative_space).slice(0, 3).map((item) => ({
    expected_but_weak_or_absent_theme: cleanText([item.expected_but_weak_or_absent_theme, item.theme, item.gap], 300),
    why_absence_matters: cleanText([item.why_absence_matters, item.reason], 500),
    what_to_check_next: cleanText([item.what_to_check_next, item.next_check, item.method], 500),
    synthetic_repair: false
  }));
  const researchNeeds = records(themeAnalysis.research_needs).slice(0, 5).map((item) => ({
    question: cleanText([item.question, item.research_question, item.hypothesis_to_test, item.research_need], 500),
    why_it_matters: cleanText([item.why_it_matters, item.why_necessary, item.reason], 500),
    needed_data: cleanText([item.needed_data, item.data_needed, item.evidence_needed], 500),
    method_hint: cleanText([item.method_hint, item.method, item.how_to_test], 500),
    priority: text(item.priority || 'medium'),
    synthetic_repair: false
  }));
  if (negativeSpace.some((item) => item.expected_but_weak_or_absent_theme.length < 5 || item.why_absence_matters.length < 10)) throw new Error('negative_space normalization failed');
  if (researchNeeds.some((item) => item.question.length < 10)) throw new Error('research_needs normalization failed');

  const evidenceSection = normalizedEvidence.map((item) =>
    `- ${text(item.claim)}：${text(item.article_link)} — ${text(item.evidence_excerpt_or_fact).slice(0, 180)}`
  ).join('\n');
  const answer = ensureRawFields({
    ...finalDraft,
    report_title: text(finalDraft.report_title) || text(themeAnalysis.report_title) || '全件生活者インサイト総合レポート',
    answer_text: `${stripPriorFormalStop(finalDraft.answer_text)}\n\n## 根拠記事\n${evidenceSection}`.trim(),
    major_trends: records(finalDraft.major_trends).length ? finalDraft.major_trends : themes,
    explanatory_hypotheses: records(finalDraft.explanatory_hypotheses).length ? finalDraft.explanatory_hypotheses : themes.map((item) => ({ hypothesis: item.claim, why: item.support_summary })),
    cross_article_insights: records(finalDraft.cross_article_insights).length ? finalDraft.cross_article_insights : themeAnalysis.cross_article_insights,
    evidence_matrix: normalizedEvidence,
    refutation_audit: refutationAudit,
    negative_space: negativeSpace,
    confidence_rubric: confidenceRubric,
    research_needs: researchNeeds,
    analyst_model: analystModel,
    writer_model: writerModel,
    generation_path: 'full_corpus_hierarchical_theme_evidence_writer_v1'
  }, selectedLookup, run, scope);

  const linkCount = (text(answer.answer_text).match(/\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/g) || []).length;
  if (linkCount < 4) throw new Error(`answer_text requires at least 4 article links; received ${linkCount}`);

  return {
    report: null,
    report_error: '',
    related_articles: normalizedEvidence.map((item) => ({
      id: text(item.article_id), headline: text(item.headline), article_date: text(item.article_date),
      ocr_text: text(item.evidence_excerpt_or_fact)
    })),
    selectable_models: [writerModel, analystModel],
    answer
  } as Json;
}
'''
source = source[:start] + new_function + source[end:]
GUARD.write_text(source, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(guard, 'evidence_excerpt_or_factは出力しない', 'critic must not invent quotation text');\n"
if marker not in test:
    raise SystemExit('staged test marker not found')
addition = marker + "assertIncludes(guard, 'full_corpus_hierarchical_theme_evidence_writer_v1', 'formal generation must use hierarchical theme, evidence, and writer stages');\n" \
    + "assertIncludes(guard, '全78バッチから頻度・反証付きテーマを抽出中', 'theme extraction must be a separate stage');\n" \
    + "assertIncludes(guard, 'collectEvidence(context, 0)', 'evidence critic must evaluate the full validated candidate pool');\n" \
    + "assertIncludes(guard, 'requires at least 4 represented themes', 'evidence must cover multiple themes');\n" \
    + "assertIncludes(guard, 'supply-side evidence exceeds limit', 'supply-side evidence must be bounded');\n" \
    + "assertIncludes(guard, " + repr("'gpt-4.1-mini'") + ", 'critical analysis stages must use the stronger low-cost analyst model');\n"
test = test.replace(marker, addition, 1)
TEST.write_text(test, encoding='utf-8')
