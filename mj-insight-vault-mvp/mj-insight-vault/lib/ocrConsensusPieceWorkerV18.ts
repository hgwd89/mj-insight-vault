import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';
import { buildArticleBlockComposite, type ArticleBlockRect } from '@/lib/articleCrop';
import { buildArticleBlockReadingPiecesV17 } from '@/lib/articleBlockReadingV17';

type JsonRecord = Record<string, unknown>;
type PassKind = 'sol' | 'terra';
type Claim = { id: string; source_job_id: string; article_count: number; is_canary: boolean; lease_token: string };
type ArticleInput = {
  article_id: string;
  source_region_id: string;
  region_quality_status: string;
  crop_version: string;
  crop_spec_sha256: string;
  crop_image_sha256: string;
  google_text: string;
  google_text_sha256: string;
  source_mode: string;
  source_image_sha256: string;
  block_rects: ArticleBlockRect[];
};
type LoadedInput = { image: Buffer; width: number; height: number; sourceImageSha256: string; articles: ArticleInput[] };
type BuiltArticle = {
  article: ArticleInput;
  crop: Awaited<ReturnType<typeof buildArticleBlockComposite>>;
  reading: Awaited<ReturnType<typeof buildArticleBlockReadingPiecesV17>>;
};
type PieceReceipt = {
  article_id: string;
  sequence: number;
  segment_count: number;
  model: string;
  segmentation_version: string;
  segmentation_spec_sha256: string;
  segment_image_sha256: string;
  block_index: number;
  block_sequence: number;
  piece_sequence: number;
  piece_count: number;
  piece_kind: string;
  source_left: number;
  source_top: number;
  source_right: number;
  source_bottom: number;
  transcription: string;
  confidence: number;
  proper_noun_status: string;
  visual_proper_nouns: string[];
  output_contract_status: string;
  reason: string;
  provider_response_id: string;
  prompt_sha256: string;
  response_sha256: string;
};

class StructuralOutputError extends Error {}
class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

const LEASE_SECONDS = 360;
const CALL_TIMEOUT_MS = 150_000;
const PIECE_MAX_OUTPUT_TOKENS = 8_000;

function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function normalizeToken(value: string) { return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return text(error.message || error.error || error.details || error);
  return text(error) || 'OCR consensus piece v18 worker failed';
}
function extractResponseText(responseJson: unknown) {
  const json = responseJson as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  return (json.output || []).flatMap((item) => item.content || []).map((item) => text(item.text)).filter(Boolean).join('\n').trim();
}
function configuredModels() {
  const sol = process.env.OPENAI_OCR_VERIFY_MODEL_V2?.trim() || 'gpt-5.6-sol';
  const terra = process.env.OPENAI_OCR_VERIFY_CRITIC_MODEL_V2?.trim() || 'gpt-5.6-terra';
  if (!sol || !terra || sol === terra) throw new StructuralOutputError('OCR consensus piece v18 requires two distinct models.');
  return { sol, terra };
}

async function claimCanary(): Promise<Claim | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_ocr_consensus_canary_v16', { p_lease_seconds: LEASE_SECONDS });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const claim: Claim = {
    id: text(row.id), source_job_id: text(row.source_job_id), article_count: Number(row.article_count || 0),
    is_canary: row.is_canary === true, lease_token: text(row.lease_token)
  };
  if (!claim.id || !claim.source_job_id || !claim.lease_token || !claim.is_canary || claim.article_count < 1) {
    throw new StructuralOutputError('OCR consensus piece v18 claim is invalid or non-canary.');
  }
  return claim;
}

async function loadInput(claim: Claim): Promise<LoadedInput> {
  const { data, error } = await supabaseAdmin.rpc('get_ocr_consensus_page_input_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token });
  if (error) throw error;
  if (!isRecord(data) || !isRecord(data.source) || !Array.isArray(data.articles)) throw new StructuralOutputError('OCR consensus piece v18 input payload is invalid.');
  const source = data.source;
  const storagePath = text(source.storage_path);
  const width = Number(source.width || 0), height = Number(source.height || 0);
  if (!storagePath || width < 1 || height < 1) throw new StructuralOutputError('OCR consensus piece v18 source metadata is incomplete.');

  const articles = data.articles.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.block_rects)) throw new StructuralOutputError('OCR consensus piece v18 article input is invalid.');
    const article: ArticleInput = {
      article_id: text(raw.article_id), source_region_id: text(raw.source_region_id), region_quality_status: text(raw.region_quality_status),
      crop_version: text(raw.crop_version), crop_spec_sha256: text(raw.crop_spec_sha256), crop_image_sha256: text(raw.crop_image_sha256),
      google_text: text(raw.google_text), google_text_sha256: text(raw.google_text_sha256), source_mode: text(raw.source_mode), source_image_sha256: text(raw.source_image_sha256),
      block_rects: raw.block_rects.map((rect) => {
        if (!isRecord(rect)) throw new StructuralOutputError('OCR consensus piece v18 block rectangle is invalid.');
        return { block_index: Number(rect.block_index), x_min: Number(rect.x_min), y_min: Number(rect.y_min), x_max: Number(rect.x_max), y_max: Number(rect.y_max) };
      })
    };
    if (!article.article_id || article.crop_version !== 'article_geometry_mask_composite_v3' || !article.crop_spec_sha256 || !article.crop_image_sha256 || !article.google_text || !article.source_image_sha256 || !article.block_rects.length) {
      throw new StructuralOutputError(`OCR consensus piece v18 article binding is incomplete: ${article.article_id || 'unknown'}`);
    }
    return article;
  });
  if (articles.length !== claim.article_count || new Set(articles.map((item) => item.article_id)).size !== claim.article_count) {
    throw new StructuralOutputError('OCR consensus piece v18 article set is not bijective.');
  }

  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (downloaded.error) throw downloaded.error;
  if (!downloaded.data) throw new StructuralOutputError('OCR consensus piece v18 source download returned no data.');
  const image = Buffer.from(await downloaded.data.arrayBuffer());
  const sourceImageSha256 = sha256(image);
  for (const article of articles) {
    if (article.source_image_sha256 !== sourceImageSha256) throw new StructuralOutputError(`OCR consensus piece v18 source image binding changed: ${article.article_id}`);
  }
  return { image, width, height, sourceImageSha256, articles };
}

async function buildArticle(input: LoadedInput, article: ArticleInput): Promise<BuiltArticle> {
  const crop = await buildArticleBlockComposite({ imageBuffer: input.image, expectedWidth: input.width, expectedHeight: input.height, articleId: article.article_id, rects: article.block_rects });
  if (crop.cropSpecSha256 !== article.crop_spec_sha256 || crop.cropImageSha256 !== article.crop_image_sha256) {
    throw new StructuralOutputError(`OCR consensus piece v18 crop fingerprint changed: ${article.article_id}`);
  }
  const reading = await buildArticleBlockReadingPiecesV17({
    imageBuffer: input.image,
    sourceWidth: input.width,
    sourceHeight: input.height,
    articleId: article.article_id,
    rects: article.block_rects
  });
  if (!reading.pieces.length) throw new StructuralOutputError(`OCR consensus piece v18 produced no block-local pieces: ${article.article_id}`);
  return { article, crop, reading };
}

async function existingArticleIds(jobId: string, passKind: PassKind) {
  const { data, error } = await supabaseAdmin.from('ocr_independent_transcriptions_v11').select('article_id').eq('job_id', jobId).eq('pass_kind', passKind);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.article_id)).filter(Boolean));
}
async function existingDecisionIds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('ocr_consensus_decisions_v11').select('article_id').eq('job_id', jobId);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.article_id)).filter(Boolean));
}
async function nextChunkIndex(jobId: string, passKind: PassKind) {
  const { data, error } = await supabaseAdmin.from('ocr_independent_pass_runs_v11').select('chunk_index').eq('job_id', jobId).eq('pass_kind', passKind).order('chunk_index', { ascending: false }).limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? Number(data[0].chunk_index) + 1 : 0;
}
async function getPieceReceipts(jobId: string, passKind: PassKind, articleId: string): Promise<PieceReceipt[]> {
  const { data, error } = await supabaseAdmin.from('ocr_independent_segment_receipts_v16')
    .select('article_id,sequence,segment_count,model,segmentation_version,segmentation_spec_sha256,segment_image_sha256,block_index,block_sequence,piece_sequence,piece_count,piece_kind,source_left,source_top,source_right,source_bottom,transcription,confidence,proper_noun_status,visual_proper_nouns,output_contract_status,reason,provider_response_id,prompt_sha256,response_sha256')
    .eq('job_id', jobId).eq('pass_kind', passKind).eq('article_id', articleId).order('sequence', { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    article_id: text(row.article_id), sequence: Number(row.sequence), segment_count: Number(row.segment_count), model: text(row.model),
    segmentation_version: text(row.segmentation_version), segmentation_spec_sha256: text(row.segmentation_spec_sha256), segment_image_sha256: text(row.segment_image_sha256),
    block_index: Number(row.block_index), block_sequence: Number(row.block_sequence), piece_sequence: Number(row.piece_sequence), piece_count: Number(row.piece_count), piece_kind: text(row.piece_kind),
    source_left: Number(row.source_left), source_top: Number(row.source_top), source_right: Number(row.source_right), source_bottom: Number(row.source_bottom),
    transcription: String(row.transcription ?? '').trim(), confidence: Number(row.confidence), proper_noun_status: text(row.proper_noun_status),
    visual_proper_nouns: Array.isArray(row.visual_proper_nouns) ? row.visual_proper_nouns.map(text).filter(Boolean) : [], output_contract_status: text(row.output_contract_status),
    reason: text(row.reason), provider_response_id: text(row.provider_response_id), prompt_sha256: text(row.prompt_sha256), response_sha256: text(row.response_sha256)
  }));
}

function pieceResponseFormat(sequence: number) {
  return {
    type: 'json_schema', name: 'mj_independent_ocr_piece_v18', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['sequence','transcription','confidence','proper_noun_status','visual_proper_nouns','reason'],
      properties: {
        sequence: { type: 'integer', enum: [sequence] },
        transcription: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        proper_noun_status: { type: 'string', enum: ['passed','not_applicable','failed'] },
        visual_proper_nouns: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' }
      }
    }
  } as const;
}

async function callPieceVision(input: {
  model: string; passKind: PassKind; articleId: string; pieceCount: number;
  piece: BuiltArticle['reading']['pieces'][number]; readingVersion: string; readingSpecSha256: string;
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');
  const role = input.passKind === 'sol' ? 'primary independent OCR reading-piece transcriber' : 'second independent OCR reading-piece transcriber using a different model';
  const instructions = [
    `You are a ${role} for exactly one isolated Japanese newspaper or magazine image piece.`,
    'You receive exactly ONE block-local reading-piece image. You do not receive Google OCR, candidate text, article overview, adjacent pieces, previous/next text, or the rest of the article.',
    'The image is intentionally narrow. Treat every visible glyph as pixel evidence, not as a sentence to complete.',
    'Transcribe ONLY the characters visibly present in this image, in their visible reading order. Do not improve Japanese grammar or make the fragment sound natural.',
    'Do not add sentence endings, particles, punctuation, company suffixes, honorifics, dates, digits, units, or words that are not visibly present.',
    'Never summarize, paraphrase, normalize, rewrite, reorder, silently repair, or infer clipped text from context.',
    'If any character position is genuinely unreadable or clipped, output 〓 at that position instead of guessing. A fragment ending mid-word or mid-sentence must remain a fragment.',
    'For a narrow vertical text piece, read top-to-bottom only. Cross-piece and cross-block ordering is deterministic code outside the model.',
    'confidence is confidence in this piece transcription only. Lower it for clipped, overlapping, low-resolution, or ambiguous glyphs.',
    'visual_proper_nouns must contain only proper nouns copied verbatim from this transcription and visibly confirmed in this exact image. If none are visible, use not_applicable and an empty array. If an important visible proper noun is uncertain, use failed.',
    'Return only the strict structured object.'
  ].join('\n');
  const p = input.piece;
  const metadata = JSON.stringify({
    task: 'independent_visual_ocr_piece_v18', pass_kind: input.passKind, article_id: input.articleId,
    sequence: p.sequence, piece_total: input.pieceCount, reading_version: input.readingVersion, reading_spec_sha256: input.readingSpecSha256,
    block_index: p.blockIndex, block_sequence: p.blockSequence, piece_sequence: p.pieceSequence, piece_count: p.pieceCount, piece_kind: p.kind,
    source_left: p.sourceLeft, source_top: p.sourceTop, source_right: p.sourceRight, source_bottom: p.sourceBottom, image_sha256: p.imageSha256
  });
  const promptSha = sha256([input.model,input.passKind,instructions,metadata,p.imageSha256].join('\n---\n'));
  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: metadata },
    { type: 'input_image', image_url: `data:${p.mimeType};base64,${p.buffer.toString('base64')}`, detail: 'high' }
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: input.model, store: false, max_output_tokens: PIECE_MAX_OUTPUT_TOKENS, instructions, input: [{ role: 'user', content }], text: { format: pieceResponseFormat(p.sequence) } })
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(`OpenAI OCR piece v18 failed: ${response.status} ${response.statusText} ${raw.slice(0, 1800)}`, response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
    let json: JsonRecord;
    try { json = JSON.parse(raw) as JsonRecord; } catch { throw new ProviderError('OpenAI OCR piece v18 response JSON is malformed.', true); }
    const responseId = text(json.id), output = extractResponseText(json);
    if (!responseId || !output) {
      const status = text(json.status) || 'unknown';
      const incompleteReason = isRecord(json.incomplete_details) ? text(json.incomplete_details.reason) : '';
      const outputItems = Array.isArray(json.output) ? json.output.length : 0;
      throw new ProviderError(`OpenAI OCR piece v18 response receipt or output is missing: response_id=${responseId || 'missing'} status=${status} incomplete_reason=${incompleteReason || 'none'} output_items=${outputItems}`, true);
    }
    let parsed: JsonRecord;
    try { parsed = JSON.parse(output) as JsonRecord; } catch { throw new StructuralOutputError('OpenAI OCR piece v18 structured output is malformed.'); }
    return { parsed, responseId, promptSha, responseSha: sha256(raw) };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof StructuralOutputError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ProviderError('OpenAI OCR piece v18 request timed out.', true);
    if (error instanceof TypeError) throw new ProviderError(`OpenAI OCR piece v18 network failure: ${error.message}`, true);
    throw error;
  } finally { clearTimeout(timer); }
}

function sanitizePiece(raw: JsonRecord, sequence: number) {
  if (Number(raw.sequence) !== sequence) throw new StructuralOutputError(`OCR piece v18 sequence mismatch: expected=${sequence} actual=${raw.sequence}`);
  const transcription = String(raw.transcription ?? '').trim();
  if (!transcription) throw new StructuralOutputError(`OCR piece v18 transcription is empty: sequence=${sequence}`);
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new StructuralOutputError(`OCR piece v18 confidence is invalid: sequence=${sequence}`);
  let properNounStatus = text(raw.proper_noun_status);
  const nouns = Array.isArray(raw.visual_proper_nouns) ? raw.visual_proper_nouns.map(text).filter(Boolean) : [];
  let outputContractStatus = 'passed';
  let reason = text(raw.reason).slice(0, 1400);
  const normalized = normalizeToken(transcription);
  const broken = !['passed','not_applicable','failed'].includes(properNounStatus)
    || (properNounStatus === 'passed' && nouns.length === 0)
    || (properNounStatus === 'not_applicable' && nouns.length > 0)
    || nouns.some((noun) => !normalizeToken(noun) || !normalized.includes(normalizeToken(noun)));
  if (broken) {
    outputContractStatus = 'failed';
    properNounStatus = 'failed';
    reason = `[model_output_contract_violation] ${reason}`.slice(0, 1500);
  }
  return { transcription, confidence, properNounStatus, nouns, outputContractStatus, reason };
}

async function appendPiece(claim: Claim, passKind: PassKind, model: string, built: BuiltArticle, sequence: number) {
  const piece = built.reading.pieces.find((item) => item.sequence === sequence);
  if (!piece) throw new StructuralOutputError(`OCR piece v18 missing generated piece: ${sequence}`);
  const result = await callPieceVision({ model, passKind, articleId: built.article.article_id, pieceCount: built.reading.pieces.length, piece, readingVersion: built.reading.version, readingSpecSha256: built.reading.readingSpecSha256 });
  const row = sanitizePiece(result.parsed, sequence);
  const { data, error } = await supabaseAdmin.rpc('append_ocr_independent_piece_v18', {
    p_job_id: claim.id, p_lease_token: claim.lease_token, p_pass_kind: passKind, p_article_id: built.article.article_id,
    p_sequence: piece.sequence, p_segment_count: built.reading.pieces.length, p_model: model,
    p_segmentation_version: built.reading.version, p_segmentation_spec_sha256: built.reading.readingSpecSha256, p_segment_image_sha256: piece.imageSha256,
    p_block_index: piece.blockIndex, p_block_sequence: piece.blockSequence, p_piece_sequence: piece.pieceSequence, p_piece_count: piece.pieceCount, p_piece_kind: piece.kind,
    p_source_left: piece.sourceLeft, p_source_top: piece.sourceTop, p_source_right: piece.sourceRight, p_source_bottom: piece.sourceBottom,
    p_transcription: row.transcription, p_confidence: row.confidence, p_proper_noun_status: row.properNounStatus, p_visual_proper_nouns: row.nouns,
    p_output_contract_status: row.outputContractStatus, p_reason: row.reason, p_provider_response_id: result.responseId, p_prompt_sha256: result.promptSha, p_response_sha256: result.responseSha
  });
  if (error) throw error;
  return data;
}

function inputBinding(article: ArticleInput) {
  return sha256(`${article.article_id}:${article.crop_spec_sha256}:${article.crop_image_sha256}:${article.source_mode}:${article.source_image_sha256}`);
}

async function assembleArticle(claim: Claim, passKind: PassKind, model: string, built: BuiltArticle, receipts: PieceReceipt[]) {
  const expectedCount = built.reading.pieces.length;
  if (receipts.length !== expectedCount) throw new StructuralOutputError(`OCR piece v18 assembly incomplete: ${receipts.length}/${expectedCount}`);
  for (let i = 0; i < expectedCount; i += 1) {
    const expected = built.reading.pieces[i];
    const receipt = receipts[i];
    if (receipt.sequence !== expected.sequence || receipt.segment_count !== expectedCount || receipt.model !== model
      || receipt.segmentation_version !== built.reading.version || receipt.segmentation_spec_sha256 !== built.reading.readingSpecSha256
      || receipt.segment_image_sha256 !== expected.imageSha256 || receipt.block_index !== expected.blockIndex || receipt.block_sequence !== expected.blockSequence
      || receipt.piece_sequence !== expected.pieceSequence || receipt.piece_count !== expected.pieceCount || receipt.piece_kind !== expected.kind
      || receipt.source_left !== expected.sourceLeft || receipt.source_top !== expected.sourceTop || receipt.source_right !== expected.sourceRight || receipt.source_bottom !== expected.sourceBottom) {
      throw new StructuralOutputError(`OCR piece v18 receipt binding mismatch: article=${built.article.article_id} sequence=${expected.sequence}`);
    }
  }
  const transcription = receipts.map((row) => row.transcription).join('\n');
  const confidence = Math.min(...receipts.map((row) => row.confidence));
  const nouns = [...new Set(receipts.flatMap((row) => row.visual_proper_nouns))];
  const outputContractStatus = receipts.some((row) => row.output_contract_status === 'failed') ? 'failed' : 'passed';
  const properNounStatus = receipts.some((row) => row.proper_noun_status === 'failed') ? 'failed' : nouns.length ? 'passed' : 'not_applicable';
  const reason = `mechanical_block_piece_concatenation_v18 pieces=${expectedCount} min_piece_confidence=${confidence.toFixed(4)} contract=${outputContractStatus}`;
  const providerResponseId = `piece-bundle-v18:${sha256(receipts.map((row) => row.provider_response_id).join('|'))}`;
  const promptSha = sha256(receipts.map((row) => row.prompt_sha256).join('|'));
  const responseSha = sha256(receipts.map((row) => row.response_sha256).join('|'));
  const chunkIndex = await nextChunkIndex(claim.id, passKind);
  const { data, error } = await supabaseAdmin.rpc('append_ocr_independent_pass_v11', {
    p_job_id: claim.id, p_lease_token: claim.lease_token, p_pass_kind: passKind, p_chunk_index: chunkIndex, p_model: model,
    p_provider_response_id: providerResponseId, p_prompt_sha256: promptSha, p_response_sha256: responseSha, p_input_binding_sha256: inputBinding(built.article),
    p_rows: [{ article_id: built.article.article_id, transcription, confidence, proper_noun_status: properNounStatus, visual_proper_nouns: nouns, output_contract_status: outputContractStatus, reason }]
  });
  if (error) throw error;
  return data;
}

async function runPassStep(claim: Claim, input: LoadedInput, passKind: PassKind, model: string, allowedIds?: Set<string>) {
  const completed = await existingArticleIds(claim.id, passKind);
  for (const article of input.articles) {
    if (completed.has(article.article_id) || (allowedIds && !allowedIds.has(article.article_id))) continue;
    const built = await buildArticle(input, article);
    const receipts = await getPieceReceipts(claim.id, passKind, article.article_id);
    const existingSequences = new Set(receipts.map((row) => row.sequence));
    const missing = built.reading.pieces.find((piece) => !existingSequences.has(piece.sequence));
    if (missing) {
      return { action: 'piece', article_id: article.article_id, sequence: missing.sequence, piece_count: built.reading.pieces.length, block_index: missing.blockIndex, piece_sequence: missing.pieceSequence, result: await appendPiece(claim, passKind, model, built, missing.sequence), external_calls: 1 };
    }
    return { action: 'assemble', article_id: article.article_id, piece_count: built.reading.pieces.length, result: await assembleArticle(claim, passKind, model, built, receipts), external_calls: 0 };
  }
  return { action: 'complete', external_calls: 0 };
}

async function evaluateUndecided(claim: Claim, input: LoadedInput) {
  const decided = await existingDecisionIds(claim.id);
  const terraRequired = new Set<string>();
  for (const article of input.articles) {
    if (decided.has(article.article_id)) continue;
    const { data, error } = await supabaseAdmin.rpc('decide_ocr_consensus_article_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token, p_article_id: article.article_id });
    if (error) throw error;
    const status = text(isRecord(data) ? data.status : '');
    if (status === 'terra_required') terraRequired.add(article.article_id);
    else if (!['passed_single','passed_two_model','needs_review','sol_required'].includes(status)) throw new StructuralOutputError(`OCR consensus piece v18 decision state is invalid: ${status || 'empty'}`);
  }
  return terraRequired;
}

async function yieldJob(claim: Claim, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_ocr_consensus_job_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token, p_stage: stage });
  if (error) throw error;
  return data;
}
async function finishJob(claim: Claim) {
  const { data, error } = await supabaseAdmin.rpc('finish_ocr_consensus_job_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token });
  if (error) throw error;
  return data;
}
async function failJob(claim: Claim, errorValue: unknown) {
  const retryable = errorValue instanceof ProviderError ? errorValue.retryable : false;
  const { data, error } = await supabaseAdmin.rpc('fail_ocr_consensus_job_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token, p_error: errorMessage(errorValue), p_retryable: retryable });
  if (error) throw error;
  return data;
}

export async function getOcrConsensusPieceV18Status() {
  const { data: jobs, error: jobsError } = await supabaseAdmin.from('ocr_consensus_jobs_v11').select('id,status,is_canary,article_count').eq('is_canary', true);
  if (jobsError) throw jobsError;
  const ids = (jobs || []).map((row) => text(row.id)).filter(Boolean);
  let pieceReceipts = 0;
  let articleTranscriptions = 0;
  if (ids.length) {
    const pieceResult = await supabaseAdmin.from('ocr_independent_segment_receipts_v16').select('id', { count: 'exact', head: true }).in('job_id', ids);
    if (pieceResult.error) throw pieceResult.error;
    pieceReceipts = pieceResult.count || 0;
    const articleResult = await supabaseAdmin.from('ocr_independent_transcriptions_v11').select('article_id', { count: 'exact', head: true }).in('job_id', ids);
    if (articleResult.error) throw articleResult.error;
    articleTranscriptions = articleResult.count || 0;
  }
  return { canary_jobs: (jobs || []).length, jobs, piece_receipts: pieceReceipts, article_transcriptions: articleTranscriptions };
}

export async function runOcrConsensusPieceV18Step() {
  const claim = await claimCanary();
  if (!claim) return { claimed: 0, stage: 'idle', external_calls: 0 };
  let externalCalls = 0;
  try {
    const input = await loadInput(claim);
    const models = configuredModels();

    const solExisting = await existingArticleIds(claim.id, 'sol');
    if (solExisting.size < claim.article_count) {
      const step = await runPassStep(claim, input, 'sol', models.sol);
      externalCalls = step.external_calls;
      return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: `sol_${step.action}`, step, yield: await yieldJob(claim, `sol_${step.action}`), external_calls: externalCalls };
    }

    let terraRequired = await evaluateUndecided(claim, input);
    if (terraRequired.size) {
      const terraExisting = await existingArticleIds(claim.id, 'terra');
      const terraMissing = new Set([...terraRequired].filter((articleId) => !terraExisting.has(articleId)));
      if (terraMissing.size) {
        const step = await runPassStep(claim, input, 'terra', models.terra, terraMissing);
        externalCalls = step.external_calls;
        return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: `terra_${step.action}`, step, yield: await yieldJob(claim, `terra_${step.action}`), external_calls: externalCalls };
      }
      terraRequired = await evaluateUndecided(claim, input);
      if (terraRequired.size) throw new StructuralOutputError(`OCR consensus piece v18 still requires Terra after completion: ${[...terraRequired].join(',')}`);
    }

    const decided = await existingDecisionIds(claim.id);
    if (decided.size !== claim.article_count) throw new StructuralOutputError(`OCR consensus piece v18 decisions incomplete: ${decided.size}/${claim.article_count}`);
    return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: 'finalize', result: await finishJob(claim), external_calls: 0 };
  } catch (error) {
    return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: 'failed', error: errorMessage(error), result: await failJob(claim, error), external_calls: externalCalls };
  }
}
