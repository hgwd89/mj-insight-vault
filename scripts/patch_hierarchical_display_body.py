from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
QUALITY = ROOT / 'lib/chatAnalysisQualityGate.ts'
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

quality = QUALITY.read_text(encoding='utf-8')
old_quality = r"""  let body = moveCoverageToEnd(rawAnswerText);
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  if (!body.includes('## 99. カバレッジ・システム情報')) {
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

  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (!hierarchicalReport && evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) body = `${body}\n\n${evidenceLinks}`.trim();
  const appendix = qualityAppendix(rawGate);
  if (appendix && !body.includes('## 11. 品質ゲート補足')) body = `${body}\n\n${appendix}`.trim();
"""
new_quality = r"""  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
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
"""
if old_quality in quality:
    quality = quality.replace(old_quality, new_quality, 1)
elif new_quality not in quality:
    raise SystemExit('hierarchical display body block not found')
QUALITY.write_text(quality, encoding='utf-8')

guard = GUARD.read_text(encoding='utf-8')
old_rule = "      'JSONはreport_title、answer_text、major_trends、explanatory_hypotheses、cross_article_insightsだけを持つ完全なオブジェクトにする。'"
new_rule = "      '最終WriterはJSONではなく日本語Markdown本文だけを返す。JSON、コードフェンス、前置きは禁止する。'"
if old_rule not in guard:
    raise SystemExit('final writer output rule not found')
guard = guard.replace(old_rule, new_rule, 1)

old_final = r"""  const finalCompletion = await timeout((signal) => openai.chat.completions.create({
    model: writerModel,
    ...(writerModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: 2_500,
    messages: [
      {
        role: 'system',
        content: 'Return one concise complete JSON object only. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the Japanese answer_text between 1,600 and 2,600 characters.'
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
  const finalText = text(finalDraft.answer_text);
"""
new_final = r"""  const finalCompletion = await timeout((signal) => openai.chat.completions.create({
    model: writerModel,
    ...(writerModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    max_completion_tokens: 2_500,
    messages: [
      {
        role: 'system',
        content: 'Return only the Japanese Markdown report body. Do not return JSON, a code fence, a title wrapper, or any preface. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the body between 1,600 and 2,600 Japanese characters.'
      },
      { role: 'user', content: JSON.stringify(finalPayload) }
    ]
  }, { signal }), stageTimeout);

  const finalText = text(finalCompletion.choices[0]?.message.content)
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const finalDraft: Json = {
    report_title: text(themeAnalysis.report_title) || '全件生活者インサイト総合レポート',
    answer_text: finalText,
    major_trends: themes,
    explanatory_hypotheses: themes.map((item) => ({ hypothesis: item.claim, why: item.support_summary })),
    cross_article_insights: themeAnalysis.cross_article_insights
  };
"""
if old_final not in guard:
    raise SystemExit('final writer JSON block not found')
guard = guard.replace(old_final, new_final, 1)
GUARD.write_text(guard, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
display_marker = "assertIncludes(qualityGate, '!hierarchicalReport', 'hierarchical reports must not duplicate evidence appendices');\n"
display_addition = display_marker + "assertIncludes(qualityGate, 'hierarchicalReport ? rawAnswerText.trim()', 'hierarchical report body must remain writer-bounded');\n" \
    + "assertIncludes(qualityGate, '!hierarchicalReport && !body.includes', 'hierarchical reports must not append coverage prose');\n" \
    + "assertIncludes(qualityGate, '!hierarchicalReport && appendix', 'hierarchical reports must not append quality prose');\n"
if "hierarchical report body must remain writer-bounded" not in test:
    if display_marker not in test:
        raise SystemExit('display body test marker not found')
    test = test.replace(display_marker, display_addition, 1)

final_marker = "assertIncludes(guard, 'max_completion_tokens: 2_500', 'final writer output must stay concise');\n"
final_addition = final_marker + "assertIncludes(guard, 'Return only the Japanese Markdown report body', 'final writer must avoid a fragile JSON envelope');\n" \
    + "assertIncludes(guard, \"const finalText = text(finalCompletion.choices[0]?.message.content)\", 'final writer body must be consumed directly');\n" \
    + "assertExcludes(guard, 'final writer JSON invalid or truncated', 'final writer must not depend on JSON parsing');\n"
if "final writer must avoid a fragile JSON envelope" not in test:
    if final_marker not in test:
        raise SystemExit('final writer test marker not found')
    test = test.replace(final_marker, final_addition, 1)
TEST.write_text(test, encoding='utf-8')
