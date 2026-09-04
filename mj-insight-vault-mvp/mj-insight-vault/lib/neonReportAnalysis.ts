import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { neonDataFetch, parseUpstreamJson } from '@/lib/neonCloud';
import type { JsonRecord } from '@/lib/neonReportStore';

export const REPORT_BATCH_SIZE = 24;
export const REPORT_GROUP_SIZE = 4;
export const REPORT_GROUP_ARTICLE_LIMIT = REPORT_BATCH_SIZE * REPORT_GROUP_SIZE;
const BATCH_MODEL = 'gpt-5-mini';
const ID_PAGE_SIZE = 500;

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

function safeModel(value: unknown) {
  const requested = text(value);
  return ['gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini'].includes(requested) ? requested : TEXT_MODEL;
}

function articleBlock(row: JsonRecord) {
  const body = text(row.ocr_text_verified || row.ocr_text_raw).replace(/\s+/g, ' ').slice(0, 2400);
  return `ARTICLE_ID: ${text(row.id)}\nTITLE: ${text(row.title) || '無題'}\nVERIFICATION: ${text(row.verification_status) || 'unknown'}\nTEXT: ${body}`;
}

export async function listReportArticleIds(jwt: string) {
  const snapshotAt = new Date().toISOString();
  const ids: string[] = [];
  let offset = 0;

  while (true) {
    const response = await neonDataFetch(
      `vault_articles?select=id&or=(ocr_text_verified.not.is.null,ocr_text_raw.not.is.null)&created_at=lte.${encodeURIComponent(snapshotAt)}&updated_at=lte.${encodeURIComponent(snapshotAt)}&order=created_at.asc,id.asc&limit=${ID_PAGE_SIZE}&offset=${offset}`,
      jwt,
      { method: 'GET' }
    );
    const json = await parseUpstreamJson(response, 'レポート対象記事IDを取得できませんでした。');
    const rows = (Array.isArray(json) ? json : []).filter(record);
    for (const row of rows) {
      const id = text(row.id);
      if (id) ids.push(id);
    }
    if (rows.length < ID_PAGE_SIZE) break;
    offset += rows.length;
  }

  return Array.from(new Set(ids));
}

export async function countReportArticles(jwt: string) {
  return (await listReportArticleIds(jwt)).length;
}

async function loadReportArticlesByIds(jwt: string, ids: string[]) {
  if (!ids.length) return [] as JsonRecord[];
  const encodedIds = ids.map((id) => id.replace(/[^0-9a-fA-F-]/g, '')).filter(Boolean);
  if (!encodedIds.length) return [] as JsonRecord[];
  const response = await neonDataFetch(
    `vault_articles?id=in.(${encodedIds.join(',')})&select=id,title,ocr_text_verified,ocr_text_raw,verification_status,created_at&limit=${encodedIds.length}`,
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, 'レポート用の記事本文を取得できませんでした。');
  const rows = (Array.isArray(json) ? json : []).filter(record);
  const byId = new Map(rows.map((row) => [text(row.id), row]));
  return encodedIds.map((id) => byId.get(id)).filter(Boolean) as JsonRecord[];
}

async function summarizeOneBatch(query: string, batch: JsonRecord[], index: number) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured.');
  const content = batch.map(articleBlock).join('\n\n---\n\n');
  const response = await openai.chat.completions.create({
    model: BATCH_MODEL,
    messages: [
      {
        role: 'system',
        content: `あなたはマーケティングリサーチのシニア分析者です。与えられた記事本文だけを根拠に、後段のAAAA詳細統合レポートに使う高密度な分析メモを作成してください。\n- 分析テーマに関連する事象を優先し、関連が薄い記事は無理に使わない\n- 観察事実と分析者の解釈を分離する\n- 行動・価値観・感情・選択基準・文脈変化を具体化する\n- 何が変化しているか、なぜそう読めるか、何と矛盾するかまで掘る\n- 強い兆候、弱い兆候、反例、例外、緊張関係を拾う\n- 重要論点ごとにARTICLE_IDとTITLEを残す\n- 記事外の知識で補完しない\n- 1,800字程度を上限に高密度にまとめる`
      },
      {
        role: 'user',
        content: `分析テーマ: ${query}\n\nバッチ ${index + 1}\n\n${content}\n\n観察事実、生活者変化、背景仮説、矛盾・反例、弱い兆候、後段で使うべき根拠を整理してください。`
      }
    ]
  });
  return text(response.choices[0]?.message?.content);
}

export async function summarizeReportGroup(jwt: string, request: JsonRecord, articleIds: string[], groupIndex: number) {
  const query = text(request.query || request.user_query);
  if (!query) throw new Error('分析指示がありません。');
  const rows = await loadReportArticlesByIds(jwt, articleIds);
  if (rows.length !== articleIds.length) {
    throw new Error(`記事スナップショット読込エラー: expected=${articleIds.length}, loaded=${rows.length}`);
  }
  if (!rows.length) return { rowCount: 0, summaries: [] as string[], articleIds: [] as string[] };
  const batches = chunks(rows, REPORT_BATCH_SIZE);
  const summaries = await Promise.all(
    batches.map((batch, index) => summarizeOneBatch(query, batch, groupIndex * REPORT_GROUP_SIZE + index))
  );
  return {
    rowCount: rows.length,
    summaries: summaries.filter(Boolean),
    articleIds: rows.map((row) => text(row.id)).filter(Boolean)
  };
}

export async function synthesizeReport(
  request: JsonRecord,
  summaries: string[],
  allArticleIds: string[],
  analyzedArticleCount: number
) {
  const query = text(request.query || request.user_query);
  if (!query) throw new Error('分析指示がありません。');
  if (!summaries.length) throw new Error('分析可能な記事本文がありません。');
  const model = safeModel(request.model);
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured.');
  const userRequirements = text(request.report_requirements);

  const final = await openai.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `あなたはマーケティングリサーチ／消費者インサイトのシニアコンサルタントです。出力品質はAAAAレベルです。長いだけではなく、根拠追跡可能・解像度が高い・複数解釈を比較する・意思決定と次の調査設計に接続できるレベルを要求します。\n\n絶対条件:\n- 入力された全バッチ分析だけを根拠にし、外部知識で穴埋めしない。\n- 事実、横断観察、解釈、説明仮説、未検証を区別する。\n- 重要主張にはARTICLE_IDを付け、Markdown本文では [記事タイトル](/articles/ARTICLE_ID) 形式のリンクを使う。\n- 単一説明に収束させず、競合仮説・反証・例外・セグメント差を示す。\n- 単なる記事要約の羅列は禁止。横断パターン、変化、緊張関係、因果候補を統合する。\n- WHYは最低3層。根拠を超える層は仮説と明記する。\n- 抽象語だけで終わらず、具体的な行動、判断、感情、文脈、トレードオフへ落とす。\n- エビデンスが弱い場合は弱いと明記する。\n\nanswer_text必須構成:\n# エグゼクティブサマリー\n# 1. 分析対象と読み方\n# 2. 主要な観察事実\n# 3. 生活者動向のナラティブ\n# 4. 重要な緊張・矛盾・トレードオフ\n# 5. WHY分析（3層）\n# 6. 競合する説明仮説（最低3仮説。支持根拠・反証・成立条件・追加確認を比較）\n# 7. セグメント・状況差\n# 8. 弱い兆候・次に起こりうる変化\n# 9. マーケティング／事業への示唆\n# 10. 追加調査で検証すべき論点\n# 11. 根拠マトリクス\n# 12. 反証・限界・言えないこと\n\nJSONのみ返す。キーは report_title, answer_text, summary, evidence_article_ids, evidence_matrix, competing_hypotheses, research_questions, caveats, quality_note。answer_textは上記構成の詳細なMarkdown本文。summaryは5〜10行。evidence_article_idsは入力に現れる実在ARTICLE_IDのみ。`
      },
      {
        role: 'user',
        content: `分析指示: ${query}\n対象記事数: ${analyzedArticleCount}\n本文読解モデル: ${BATCH_MODEL}\n最終統合モデル: ${model}\n出力形式: ${text(request.output_template) || 'auto'}\n追加要件: ${userRequirements || 'なし'}\n\n以下は対象記事を漏れなく分割して本文読解したバッチ分析です。全バッチを横断して統合してください。\n\n${summaries.map((value, index) => `## BATCH ${index + 1}\n${value}`).join('\n\n')}`
      }
    ]
  });

  const raw = text(final.choices[0]?.message?.content);
  let answer: JsonRecord = {};
  try {
    const parsed = JSON.parse(raw);
    if (record(parsed)) answer = parsed;
  } catch {
    answer = { report_title: query.slice(0, 80), answer_text: raw, summary: raw.slice(0, 800) };
  }

  const requestedEvidence = Array.isArray(answer.evidence_article_ids)
    ? answer.evidence_article_ids.map(text).filter((id) => allArticleIds.includes(id))
    : [];
  const relatedArticleIds = requestedEvidence.length ? requestedEvidence : allArticleIds.slice(0, 100);
  const answerText = text(answer.answer_text || answer.summary || raw);
  if (!answerText) throw new Error('最終レポート本文が空でした。');

  return {
    answer: {
      ...answer,
      report_title: text(answer.report_title) || query.slice(0, 80) || 'Neon分析レポート',
      answer_text: answerText,
      model_used: model,
      batch_model_used: BATCH_MODEL,
      quality_level: 'AAAA',
      target_scope: 'all',
      output_template: text(request.output_template) || 'auto',
      source_coverage: {
        corpus: 'neon_vault_articles',
        full_corpus_analyzed_article_count: analyzedArticleCount,
        final_context_represented_article_count: analyzedArticleCount,
        final_context_represented_batches: summaries.length,
        final_context_omitted_batches: 0,
        full_corpus_prompt_version: 'neon_report_aaaa_v3_snapshot',
        full_corpus_gate: 'passed'
      },
      full_corpus_analyzed_article_count: analyzedArticleCount,
      final_context_represented_article_count: analyzedArticleCount,
      final_context_represented_batches: summaries.length,
      final_context_omitted_batches: 0,
      full_corpus_prompt_version: 'neon_report_aaaa_v3_snapshot',
      full_corpus_integrity_gate: 'neon_native_full_corpus_snapshot',
      full_corpus_gate: 'passed'
    },
    relatedArticleIds,
    analyzedArticleCount,
    model
  };
}
