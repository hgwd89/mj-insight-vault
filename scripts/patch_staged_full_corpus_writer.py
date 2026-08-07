from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

source = GUARD.read_text(encoding='utf-8')

old_enrich = """    return {
      ...seed,
      headline,
      article_date: date,
      article_url: `/articles/${seed.article_id}`,
      article_link: `[${headline}｜${date}](/articles/${seed.article_id})`,
      ocr_text: text(row.ocr_text).replace(/\s+/g, ' ').slice(0, 500)
    };
"""
new_enrich = """    const normalizedOcr = text(row.ocr_text).replace(/\s+/g, ' ');
    const seedFact = text(seed.evidence_excerpt_or_fact).replace(/\s+/g, ' ');
    const groundedFact = seedFact && normalizedOcr.includes(seedFact)
      ? seedFact
      : normalizedOcr.slice(0, 360);
    return {
      ...seed,
      headline,
      article_date: date,
      article_url: `/articles/${seed.article_id}`,
      article_link: `[${headline}｜${date}](/articles/${seed.article_id})`,
      evidence_excerpt_or_fact: groundedFact,
      ocr_text: normalizedOcr.slice(0, 500)
    };
"""
if old_enrich not in source:
    raise SystemExit('enrichEvidence block not found')
source = source.replace(old_enrich, new_enrich, 1)

old_fact = """    const evidenceFact = fact(item);
    const whatCanBeSaid = cleanText([item.what_can_be_said, evidenceFact], 700);
"""
new_fact = """    const evidenceFact = source.evidence_excerpt_or_fact;
    const whatCanBeSaid = cleanText([item.what_can_be_said, evidenceFact], 700);
"""
if old_fact not in source:
    raise SystemExit('ensureRawFields evidence block not found')
source = source.replace(old_fact, new_fact, 1)

start = source.index('async function directWriter(')
end = source.index('\nfunction formalGatePassed(', start)
new_function = r'''async function directWriter(body: Json, context: Context, scope: Scope, onProgress?: Progress): Promise<Json> {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY missing');
  const run = record(context.run) ? context.run : {};
  const model = text(body.model) || TEXT_MODEL;
  const query = [
    text(body.query),
    scope.type === 'category' ? `対象カテゴリID: ${scope.query}` : '',
    scope.name ? `対象カテゴリ名: ${scope.name}` : ''
  ].filter(Boolean).join('\n');

  await reportProgress(onProgress, 35, '全78バッチからレポート本文を統合中');
  const synthesisPayload = {
    query,
    coverage: {
      scope_type: scope.type,
      scope_query: scope.query,
      run_id: text(run.id),
      active_article_count: runValue(run, 'active_article_count'),
      analyzed_article_count: runValue(run, 'analyzed_article_count'),
      total_batches: runValue(run, 'total_batches'),
      represented_batches: context.represented_batches,
      represented_article_count: context.represented_article_count,
      omitted_batches: context.omitted_batches,
      prompt_version: context.prompt_version
    },
    full_corpus_batch_context_primary: parseContext(context.context_text),
    rules: [
      '全体傾向はfull_corpus_batch_context_primaryの全バッチからのみ導出する。',
      '一部バッチや個別記事へ偏らず、頻度、反例、弱いシグナル、無信号を区別する。',
      '企業施策・商品投入・販路拡大を生活者需要の直接証拠へ変換しない。',
      '事実、推論、仮説、追加調査を分離する。',
      'answer_textは日本語1,600〜2,600文字で、結論、主要トレンド、反証・制約、実務含意、調査課題を含める。',
      'この段階では記事リンクやevidence_matrixを書かない。',
      'refutation_auditは2〜4件、negative_spaceは2〜3件、confidence_rubricは3〜5件、research_needsは3〜5件に限定する。',
      'JSON全体を必ず完結させ、重複説明を避ける。'
    ],
    required_json_fields: [
      'report_title', 'answer_text', 'major_trends', 'explanatory_hypotheses',
      'cross_article_insights', 'refutation_audit', 'negative_space',
      'confidence_rubric', 'research_needs', 'source_coverage'
    ]
  };

  const synthesisCompletion = await timeout((signal) => openai.chat.completions.create({
    model,
    ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: `${MJ_REPORT_SYSTEM_PROMPT}\n\nCRITICAL OVERRIDE: Produce a concise formal full-corpus synthesis from every supplied batch digest. Return one complete JSON object only. Do not retrieve or cite individual articles in this stage.`
      },
      { role: 'user', content: JSON.stringify(synthesisPayload) }
    ]
  }, { signal }), TIMEOUT_MS);

  const synthesisRaw = synthesisCompletion.choices[0]?.message.content || '{}';
  let synthesis: Json;
  try {
    synthesis = JSON.parse(synthesisRaw) as Json;
  } catch (error) {
    const detail = error instanceof Error ? error.message : text(error);
    throw new Error(`synthesis JSON invalid or truncated: ${detail}`);
  }

  const synthesisErrors: string[] = [];
  if (text(synthesis.answer_text).length < 800) synthesisErrors.push(`answer_text too short: ${text(synthesis.answer_text).length}`);
  for (const field of ['refutation_audit', 'negative_space', 'confidence_rubric', 'research_needs']) {
    if (!records(synthesis[field]).length) synthesisErrors.push(`${field} missing`);
  }
  if (synthesisErrors.length) throw new Error(`synthesis validation failed: ${synthesisErrors.join('; ')}`);

  await reportProgress(onProgress, 58, '全バッチから接地済み根拠候補を構築中');
  const seeds = collectEvidence(context);
  if (seeds.length < 5) throw new Error(`validated evidence insufficient: ${seeds.length}`);
  const evidenceLookup = await enrichEvidence(seeds);

  const evidencePayload = {
    report_core: {
      report_title: synthesis.report_title,
      answer_text: text(synthesis.answer_text).slice(0, 3600),
      major_trends: synthesis.major_trends,
      explanatory_hypotheses: synthesis.explanatory_hypotheses,
      cross_article_insights: synthesis.cross_article_insights
    },
    evidence_article_lookup: evidenceLookup.map((item) => ({
      article_id: item.article_id,
      headline: item.headline,
      article_date: item.article_date,
      article_link: item.article_link,
      validated_batch_fact: item.evidence_excerpt_or_fact,
      article_text_excerpt: item.ocr_text
    })),
    rules: [
      'report_coreの主要主張を実際に支持または反証する記事を5〜8件だけ選ぶ。',
      'article_idはevidence_article_lookup内だけを使い、重複させない。',
      'claimは15文字以上の分析文にし、記事見出しのコピーは禁止する。',
      'what_can_be_said、what_cannot_be_said、limitationは各10文字以上の日本語文字列にする。',
      '企業施策だけの記事は供給側シグナルとして限定し、生活者需要と断定しない。',
      'evidence_excerpt_or_factは出力しない。引用文はサーバーが記事本文から付与する。',
      'JSONはevidence_matrixだけを持つ完全なオブジェクトとして返す。'
    ],
    required_shape: {
      evidence_matrix: [{
        article_id: 'uuid',
        claim: 'analytical claim',
        what_can_be_said: 'bounded conclusion',
        what_cannot_be_said: 'unsupported conclusion',
        limitation: 'limitation',
        evidence_strength: 'A|B|C'
      }]
    }
  };

  let evidenceSelection: Json[] = [];
  let evidenceFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await reportProgress(onProgress, 64 + (attempt - 1) * 10, `Evidence Criticで根拠を選定中 (${attempt}/2)`);
    const criticPayload = evidenceFeedback.length
      ? { ...evidencePayload, validation_feedback_from_previous_attempt: evidenceFeedback }
      : evidencePayload;
    const criticCompletion = await timeout((signal) => openai.chat.completions.create({
      model,
      ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: Math.min(MAX_TOKENS, 3_000),
      messages: [
        {
          role: 'system',
          content: 'Return one complete JSON object only. Act as an evidence critic. Select only grounded, relevant and non-duplicated evidence for the supplied report core. Do not write the report body.'
        },
        { role: 'user', content: JSON.stringify(criticPayload) }
      ]
    }, { signal }), TIMEOUT_MS);
    const criticRaw = criticCompletion.choices[0]?.message.content || '{}';
    let critic: Json;
    try {
      critic = JSON.parse(criticRaw) as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      evidenceFeedback = [`invalid or truncated JSON: ${detail}`, 'Return exactly 5 concise evidence objects and complete the JSON.'];
      continue;
    }
    const merged = ensureRawFields({ ...synthesis, evidence_matrix: critic.evidence_matrix }, evidenceLookup, run, scope);
    const candidate = records(merged.evidence_matrix);
    const errors: string[] = [];
    if (candidate.length < 5 || candidate.length > 8) errors.push(`requires 5〜8 valid evidence items; received ${candidate.length}`);
    if (candidate.some((item) => text(item.claim).length < 15)) errors.push('all evidence claims must be at least 15 characters');
    if (candidate.some((item) => brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said))) errors.push('evidence contains malformed text');
    if (!errors.length) {
      evidenceSelection = candidate;
      break;
    }
    evidenceFeedback = errors;
  }
  if (evidenceSelection.length < 5) throw new Error(`evidence critic validation failed: ${evidenceFeedback.join('; ')}`);

  const evidenceSection = evidenceSelection.map((item) =>
    `- ${text(item.claim)}：${text(item.article_link)} — ${text(item.evidence_excerpt_or_fact).slice(0, 180)}`
  ).join('\n');
  const mergedAnswer = ensureRawFields({
    ...synthesis,
    answer_text: `${stripPriorFormalStop(synthesis.answer_text)}\n\n## 根拠記事\n${evidenceSection}`.trim(),
    evidence_matrix: evidenceSelection,
    generation_path: 'full_corpus_staged_writer_evidence_critic_v1'
  }, evidenceLookup, run, scope);

  const linkCount = (text(mergedAnswer.answer_text).match(/\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/g) || []).length;
  if (linkCount < 3) throw new Error(`answer_text requires at least 3 article links; received ${linkCount}`);

  return {
    report: null,
    report_error: '',
    related_articles: evidenceSelection.map((item) => ({
      id: text(item.article_id),
      headline: text(item.headline),
      article_date: text(item.article_date),
      ocr_text: text(item.evidence_excerpt_or_fact)
    })),
    selectable_models: [model],
    answer: mergedAnswer
  } as Json;
}
'''
source = source[:start] + new_function + source[end:]
GUARD.write_text(source, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(guard, 'evidence_matrixは異なるarticle_idを5〜8件', 'writer evidence output must remain concise');\n"
if marker not in test:
    raise SystemExit('test marker not found')
addition = marker + "assertIncludes(guard, 'full_corpus_staged_writer_evidence_critic_v1', 'formal generation must use staged writer and evidence critic');\n" \
    + "assertIncludes(guard, 'Evidence Criticで根拠を選定中', 'evidence selection must be a separate model stage');\n" \
    + "assertIncludes(guard, 'evidence_excerpt_or_fact: groundedFact', 'citation facts must be grounded to article text');\n" \
    + "assertIncludes(guard, 'evidence_excerpt_or_factは出力しない', 'critic must not invent quotation text');\n"
test = test.replace(marker, addition, 1)
TEST.write_text(test, encoding='utf-8')
