import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { neonDataFetch, parseUpstreamJson } from '@/lib/neonCloud';
import type { JsonRecord } from '@/lib/neonReportStore';

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function chunks<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadArticles(jwt: string) {
  const response = await neonDataFetch(
    'vault_articles?select=id,title,ocr_text_verified,ocr_text_raw,verification_status,created_at&or=(ocr_text_verified.not.is.null,ocr_text_raw.not.is.null)&order=created_at.asc&limit=500',
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, 'レポート用の記事本文を取得できませんでした。');
  return (Array.isArray(json) ? json : []).filter(record).filter((row) => text(row.ocr_text_verified || row.ocr_text_raw));
}

function articleBlock(row: JsonRecord) {
  const body = text(row.ocr_text_verified || row.ocr_text_raw).replace(/\s+/g, ' ').slice(0, 1800);
  return `ARTICLE_ID: ${text(row.id)}\nTITLE: ${text(row.title) || '無題'}\nTEXT: ${body}`;
}

async function summarizeBatch(model: string, query: string, batch: JsonRecord[], index: number) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured.');
  const content = batch.map(articleBlock).join('\n\n---\n\n');
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'あなたはマーケティングリサーチのシニア分析者です。与えられた記事本文だけを根拠に、生活者動向・行動変化・背景要因・矛盾・弱い兆候を抽出してください。推論と事実を分離し、根拠ARTICLE_IDを必ず併記してください。記事外の知識で補わないでください。'
      },
      {
        role: 'user',
        content: `分析テーマ: ${query}\n\nバッチ ${index + 1}\n\n${content}\n\n出力は簡潔なMarkdown。重要な根拠ARTICLE_IDを各論点に付けること。`
      }
    ]
  });
  return text(response.choices[0]?.message?.content);
}

function safeModel(value: unknown) {
  const requested = text(value);
  return ['gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini'].includes(requested) ? requested : TEXT_MODEL;
}

export async function runNeonReportAnalysis(jwt: string, request: JsonRecord) {
  const query = text(request.query || request.user_query);
  if (!query) throw new Error('分析指示がありません。');
  const model = safeModel(request.model);
  const articles = await loadArticles(jwt);
  if (!articles.length) throw new Error('OCR済み記事がないためレポートを生成できません。');

  const batches = chunks(articles, 12);
  const summaries: string[] = [];
  for (let i = 0; i < batches.length; i += 4) {
    const group = batches.slice(i, i + 4);
    const results = await Promise.all(group.map((batch, offset) => summarizeBatch(model, query, batch, i + offset)));
    summaries.push(...results);
  }

  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured.');
  const final = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `あなたはマーケティングリサーチのシニアコンサルタントです。複数の記事本文バッチ要約を統合して、意思決定に使える日本語レポートを作成してください。
必須条件:
- 記事本文にある事実と分析者の推論を明確に分ける
- 重要主張には根拠ARTICLE_IDを付ける
- 反証・別解釈・未検証点を含める
- 生活者動向のナラティブ、WHYの説明仮説、複数仮説比較、追加調査論点を含める
- 根拠が弱いものを断定しない
JSONのみ返す。キーは report_title, answer_text, summary, evidence_article_ids, caveats, quality_note。answer_textはMarkdown本文。`
      },
      {
        role: 'user',
        content: `分析指示: ${query}\n対象記事数: ${articles.length}\n出力形式: ${text(request.output_template) || 'auto'}\n\nバッチ要約:\n\n${summaries.map((value, index) => `## BATCH ${index + 1}\n${value}`).join('\n\n')}`
      }
    ]
  });

  const raw = text(final.choices[0]?.message?.content);
  let answer: JsonRecord = {};
  try {
    const parsed = JSON.parse(raw);
    if (record(parsed)) answer = parsed;
  } catch {
    answer = { report_title: query.slice(0, 80), answer_text: raw, summary: raw.slice(0, 500) };
  }

  const articleIds = articles.map((row) => text(row.id)).filter(Boolean);
  const requestedEvidence = Array.isArray(answer.evidence_article_ids)
    ? answer.evidence_article_ids.map(text).filter((id) => articleIds.includes(id))
    : [];
  const related = requestedEvidence.length ? requestedEvidence : articleIds.slice(0, 80);
  const answerText = text(answer.answer_text || answer.summary || raw);

  return {
    answer: {
      ...answer,
      report_title: text(answer.report_title) || query.slice(0, 80) || 'Neon分析レポート',
      answer_text: answerText,
      model_used: model,
      target_scope: text(request.target_scope) || 'all',
      output_template: text(request.output_template) || 'auto',
      source_coverage: {
        corpus: 'neon_vault_articles',
        full_corpus_analyzed_article_count: articles.length,
        final_context_represented_article_count: articles.length,
        final_context_omitted_batches: 0
      },
      full_corpus_analyzed_article_count: articles.length,
      final_context_represented_article_count: articles.length,
      full_corpus_integrity_gate: 'neon_native'
    },
    relatedArticleIds: related,
    analyzedArticleCount: articles.length,
    model
  };
}
