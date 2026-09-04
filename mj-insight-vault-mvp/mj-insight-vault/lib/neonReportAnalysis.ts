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
  const body = text(row.ocr_text_verified || row.ocr_text_raw).replace(/\s+/g, ' ').slice(0, 2200);
  return `ARTICLE_ID: ${text(row.id)}\nTITLE: ${text(row.title) || '無題'}\nVERIFICATION: ${text(row.verification_status) || 'unknown'}\nTEXT: ${body}`;
}

async function summarizeBatch(model: string, query: string, batch: JsonRecord[], index: number) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured.');
  const content = batch.map(articleBlock).join('\n\n---\n\n');
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.15,
    messages: [
      {
        role: 'system',
        content: `あなたはマーケティングリサーチのシニア分析者です。与えられた記事本文だけを根拠に、後段の詳細統合レポートに耐える高密度な分析メモを作ってください。
必須:
- 観察事実と分析者の解釈を分離する
- 生活者の行動・価値観・感情・選択基準・文脈変化を具体化する
- 単なる話題要約ではなく「何が変化しているか」「なぜそう読めるか」「何と矛盾するか」まで掘る
- 強い兆候、弱い兆候、反例、例外、緊張関係を拾う
- 同じテーマでも異なる生活者像・状況・動機を分ける
- 重要論点ごとにARTICLE_IDとTITLEを必ず残す
- 数字・固有名詞・具体行動は本文にある場合だけ使う
- 記事外の知識で補完しない
- 後段で根拠追跡できるよう、重要な事実表現は本文に忠実に要約する`
      },
      {
        role: 'user',
        content: `分析テーマ: ${query}\n\nバッチ ${index + 1}\n\n${content}\n\n以下をMarkdownで整理してください。\n1. このバッチで最も重要な観察事実\n2. 生活者の行動・感情・価値観の変化\n3. 背景要因として読めること（推論と明記）\n4. 矛盾・反例・異なるセグメント\n5. 弱い兆候・今後の変化候補\n6. 後段で使うべき根拠（ARTICLE_ID、TITLE、何の根拠か）`
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

  const batches = chunks(articles, 10);
  const summaries: string[] = [];
  for (let i = 0; i < batches.length; i += 4) {
    const group = batches.slice(i, i + 4);
    const results = await Promise.all(group.map((batch, offset) => summarizeBatch(model, query, batch, i + offset)));
    summaries.push(...results);
  }

  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured.');
  const userRequirements = text(request.report_requirements);
  const final = await openai.chat.completions.create({
    model,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `あなたはマーケティングリサーチ／消費者インサイトのシニアコンサルタントです。出力品質はAAAAレベルを要求します。AAAAとは、長いだけではなく、根拠追跡可能・解像度が高い・複数解釈を比較する・意思決定と次の調査設計に接続できるレベルです。

絶対条件:
- 入力された記事本文バッチ要約だけを根拠にする。外部知識で穴埋めしない。
- 「記事に書かれている事実」「複数記事を横断した観察」「分析者の解釈」「説明仮説」「未検証」を明確に区別する。
- 重要主張にはARTICLE_IDを最低1件、可能なら複数件付ける。Markdown本文では [記事タイトル](/articles/ARTICLE_ID) 形式のリンクを使う。
- 1つの説明に収束させすぎず、競合仮説・反証・例外・セグメント差を示す。
- 単なる記事要約の羅列は禁止。横断的なパターン、変化、緊張関係、因果候補を統合する。
- 「なぜ？」は最低3層に掘る。ただし記事根拠を超える層は仮説と明記する。
- 抽象語だけで終わらせず、生活者の具体的な行動、判断、感情、文脈、トレードオフへ落とす。
- エビデンスが弱い場合は弱いと明記し、断定しない。
- 最終本文は詳細版。ユーザーが元記事へ戻らなくても、何が観察され、どう解釈し、何を検証すべきか理解できる密度にする。

answer_textの必須構成:
# エグゼクティブサマリー
主要結論を3〜7点。各結論に根拠リンクと確度。

# 1. 分析対象と読み方
対象記事数、今回の分析テーマ、事実/推論/仮説の扱い。

# 2. 主要な観察事実
記事群で反復する具体的事象を、根拠付きで詳細に整理。

# 3. 生活者動向のナラティブ
「以前/前提 → 変化のきっかけ → 現在の行動・感情 → 目指している状態」の流れで複数パターンを描く。

# 4. 重要な緊張・矛盾・トレードオフ
例: 欲しいが避ける、便利だが不安、節約するがここには払う、など。実データに即して整理。

# 5. WHY分析（3層）
WHY1=直接理由、WHY2=背後の判断基準/心理、WHY3=より深い価値・自己像・生活文脈。各層を事実/推論/仮説でラベル付け。

# 6. 競合する説明仮説
最低3仮説。各仮説について、支持根拠、反証/弱点、成立しやすい条件、追加確認すべきことを比較。

# 7. セグメント・状況差
一枚岩に扱わず、異なる生活者像、利用状況、選択基準、感情差を示す。根拠不足なら不足と明記。

# 8. 弱い兆候・次に起こりうる変化
現時点では少数だが注視すべき事象。なぜ兆候と見るのか、過大解釈リスクも併記。

# 9. マーケティング／事業への示唆
観察→解釈→示唆の論理を飛ばさずに書く。商品、コミュニケーション、体験、チャネル、価格等への含意を必要な範囲で整理。

# 10. 追加調査で検証すべき論点
何を、誰に、どのように聞けば仮説を判別できるかまで具体化。定性/定量の使い分けも必要に応じて示す。

# 11. 根拠マトリクス
重要主張ごとに、主張、根拠記事リンク、観察事実、解釈、確度(A/B/C)、限界を整理。

# 12. 反証・限界・言えないこと
記事母集団、OCR、記事そのものの偏り、因果推論の限界など、今回の出力から断定できないことを明示。

JSONのみ返す。キーは report_title, answer_text, summary, evidence_article_ids, evidence_matrix, competing_hypotheses, research_questions, caveats, quality_note。
answer_textは上記構成の詳細なMarkdown本文にする。summaryは5〜10行程度の要約。evidence_article_idsは実在するARTICLE_IDのみ。`
      },
      {
        role: 'user',
        content: `分析指示: ${query}\n対象記事数: ${articles.length}\n対象バッチ数: ${batches.length}\n出力形式: ${text(request.output_template) || 'auto'}\n追加レポート要件: ${userRequirements || 'なし'}\n\n以下は全記事を分割して本文読解したバッチ分析です。全バッチを横断して統合してください。\n\n${summaries.map((value, index) => `## BATCH ${index + 1}\n${value}`).join('\n\n')}`
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

  const articleIds = articles.map((row) => text(row.id)).filter(Boolean);
  const requestedEvidence = Array.isArray(answer.evidence_article_ids)
    ? answer.evidence_article_ids.map(text).filter((id) => articleIds.includes(id))
    : [];
  const related = requestedEvidence.length ? requestedEvidence : articleIds.slice(0, 100);
  const answerText = text(answer.answer_text || answer.summary || raw);

  return {
    answer: {
      ...answer,
      report_title: text(answer.report_title) || query.slice(0, 80) || 'Neon分析レポート',
      answer_text: answerText,
      model_used: model,
      quality_level: 'AAAA',
      target_scope: text(request.target_scope) || 'all',
      output_template: text(request.output_template) || 'auto',
      source_coverage: {
        corpus: 'neon_vault_articles',
        full_corpus_analyzed_article_count: articles.length,
        final_context_represented_article_count: articles.length,
        final_context_represented_batches: batches.length,
        final_context_omitted_batches: 0,
        full_corpus_prompt_version: 'neon_report_aaaa_v1'
      },
      full_corpus_analyzed_article_count: articles.length,
      final_context_represented_article_count: articles.length,
      final_context_represented_batches: batches.length,
      final_context_omitted_batches: 0,
      full_corpus_prompt_version: 'neon_report_aaaa_v1',
      full_corpus_integrity_gate: 'neon_native'
    },
    relatedArticleIds: related,
    analyzedArticleCount: articles.length,
    model
  };
}
