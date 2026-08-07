from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

source = GUARD.read_text(encoding='utf-8')

marker = """  if (!finalText) throw new Error(`final writer validation failed: ${finalFeedback.join('; ')}`);
  const finalDraft: Json = {
"""
insert = """  if (!finalText) throw new Error(`final writer validation failed: ${finalFeedback.join('; ')}`);

  await reportProgress(onProgress, 88, 'Semantic Criticで過剰一般化とテーマ混線を検証中');
  const semanticPayload = {
    ranked_themes: themes,
    selected_evidence: normalizedEvidence.map((item) => ({
      theme_id: item.theme_id,
      evidence_type: item.evidence_type,
      claim: item.claim,
      what_can_be_said: item.what_can_be_said,
      what_cannot_be_said: item.what_cannot_be_said,
      limitation: item.limitation,
      article_link: item.article_link
    })),
    draft_markdown: finalText,
    rules: [
      'テーマごとの反証は同じテーマだけを対象にし、無関係な配送・価格・健康・AIなど別領域の反証を接続しない。',
      '企業の商品投入、出店、実証、イベントは供給側シグナルであり、購買量・利用件数・代表性ある調査がなければ需要増加とは書かない。',
      '単一記事や単一商品の事例を、市場全体、生活者全体、顕著な増加、広範な傾向の証明へ昇格しない。',
      '年代、割合、件数などの数字はselected_evidenceと完全に一致させ、矛盾やOCR疑義があれば削除または限定する。',
      '異なる調査対象の結果を同一人物の矛盾や因果として接続しない。',
      '不合格箇所があれば意味を保った校正版Markdownを返す。記事リンクと数字は入力外から追加しない。'
    ],
    required_shape: {
      status: 'passed|corrected|failed',
      reasons: ['string'],
      corrected_markdown: 'string'
    }
  };
  const semanticCompletion = await timeout((signal) => openai.chat.completions.create({
    model: analystModel,
    ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: 3_000,
    messages: [
      {
        role: 'system',
        content: 'Return one complete JSON object only. You are an adversarial marketing-research auditor. Reject cross-theme counterarguments, supply-demand conflation, anecdote-to-market generalization, unsupported causality, and numeric inconsistency. When repairable, return a fully corrected Japanese Markdown report using only the supplied themes, evidence, links and numbers.'
      },
      { role: 'user', content: JSON.stringify(semanticPayload) }
    ]
  }, { signal }), stageTimeout);
  let semanticReview: Json;
  try {
    semanticReview = JSON.parse(semanticCompletion.choices[0]?.message.content || '{}') as Json;
  } catch (error) {
    throw new Error(`semantic review JSON invalid: ${error instanceof Error ? error.message : text(error)}`);
  }
  const semanticStatus = text(semanticReview.status);
  const correctedMarkdown = text(semanticReview.corrected_markdown)
    .replace(/^```(?:markdown)?\\s*/i, '')
    .replace(/\\s*```$/, '')
    .trim();
  if (semanticStatus === 'corrected' && correctedMarkdown.length >= 1_200) finalText = correctedMarkdown;
  if (!['passed', 'corrected'].includes(semanticStatus)) {
    throw new Error(`semantic review failed: ${JSON.stringify(semanticReview.reasons || [])}`);
  }
  const semanticReasons = Array.isArray(semanticReview.reasons) ? semanticReview.reasons.map(text).filter(Boolean).slice(0, 12) : [];

  const finalDraft: Json = {
"""
if marker not in source:
    raise SystemExit('final writer loop marker not found')
source = source.replace(marker, insert, 1)

old_generation = """    ranked_themes_raw: themes,
    generation_path: 'full_corpus_hierarchical_theme_evidence_writer_v1'
"""
new_generation = """    ranked_themes_raw: themes,
    semantic_review: {
      status: 'passed',
      critic_status: semanticStatus,
      reasons: semanticReasons,
      model: analystModel,
      version: 'semantic_report_critic_v1'
    },
    generation_path: 'full_corpus_hierarchical_theme_evidence_writer_v2'
"""
if old_generation not in source:
    raise SystemExit('generation path marker not found')
source = source.replace(old_generation, new_generation, 1)
GUARD.write_text(source, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(guard, 'contains unsupported numbers', 'final writer must reject unsupplied numbers');\n"
if marker not in test:
    raise SystemExit('test insertion marker not found')
addition = marker + "assertIncludes(guard, 'Semantic Criticで過剰一般化とテーマ混線を検証中', 'semantic critic stage must run before persistence');\n" \
    + "assertIncludes(guard, 'semantic_report_critic_v1', 'semantic critic proof must be persisted');\n" \
    + "assertIncludes(guard, 'cross-theme counterarguments', 'semantic critic must reject cross-theme counterarguments');\n" \
    + "assertIncludes(guard, 'full_corpus_hierarchical_theme_evidence_writer_v2', 'semantic-reviewed generation path must be versioned');\n"
test = test.replace(marker, addition, 1)
TEST.write_text(test, encoding='utf-8')
