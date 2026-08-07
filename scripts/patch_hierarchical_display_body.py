from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
QUALITY = ROOT / 'lib/chatAnalysisQualityGate.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

quality = QUALITY.read_text(encoding='utf-8')
old = """  let body = moveCoverageToEnd(rawAnswerText);
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
new = """  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
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
if old not in quality:
    raise SystemExit('hierarchical display body block not found')
QUALITY.write_text(quality.replace(old, new, 1), encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(qualityGate, '!hierarchicalReport', 'hierarchical reports must not duplicate evidence appendices');\n"
addition = marker + "assertIncludes(qualityGate, 'hierarchicalReport ? rawAnswerText.trim()', 'hierarchical report body must remain writer-bounded');\n" \
    + "assertIncludes(qualityGate, '!hierarchicalReport && !body.includes', 'hierarchical reports must not append coverage prose');\n" \
    + "assertIncludes(qualityGate, '!hierarchicalReport && appendix', 'hierarchical reports must not append quality prose');\n"
if marker not in test:
    raise SystemExit('display body test marker not found')
TEST.write_text(test.replace(marker, addition, 1), encoding='utf-8')
