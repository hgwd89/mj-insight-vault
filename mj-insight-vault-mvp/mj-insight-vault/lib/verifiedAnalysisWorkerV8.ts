import { createHash } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';

type JsonObject = Record<string, unknown>;
type Claimed = { id: string; lease_token: string; active_pass_kind?: string; [key: string]: unknown };

const PRIMARY_MODEL = process.env.OPENAI_VERIFIED_PRIMARY_MODEL || TEXT_MODEL;
const CRITIC_MODEL = process.env.OPENAI_VERIFIED_CRITIC_MODEL || 'gpt-4.1';
const CALL_TIMEOUT_MS = 180_000;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === 'string') return error.message;
  return String(error || 'verified analysis worker failed');
}

function ensureIndependentModels() {
  if (!PRIMARY_MODEL.trim() || !CRITIC_MODEL.trim()) throw new Error('verified analysis models are not configured');
  if (PRIMARY_MODEL.trim() === CRITIC_MODEL.trim()) throw new Error('verified analysis primary and critic models must differ');
}

async function rpc<T = unknown>(fn: string, args: JsonObject = {}) {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

function firstClaim(data: unknown): Claimed | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isObject(row)) return null;
  const id = typeof row.id === 'string' ? row.id : '';
  const lease = typeof row.lease_token === 'string' ? row.lease_token : '';
  if (!id || !lease) return null;
  return { ...row, id, lease_token: lease } as Claimed;
}

async function callJsonModel(model: string, system: string, input: unknown) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');
  const user = JSON.stringify(input);
  const promptReceipt = JSON.stringify({ system, user });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }, { signal: controller.signal });
    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error('verified analysis model output must be a JSON object');
    return {
      model,
      providerResponseId: completion.id,
      promptSha256: sha256(promptReceipt),
      responseSha256: sha256(raw),
      result: parsed
    };
  } finally {
    clearTimeout(timer);
  }
}

function modelForPass(passKind: string) {
  return passKind === 'critic' ? CRITIC_MODEL : PRIMARY_MODEL;
}

async function runJsonPass(
  claim: Claimed,
  inputRpc: string,
  storeRpc: string,
  failRpc: string,
  systemForPass: (pass: string) => string,
  extraStoreArgs: (output: Awaited<ReturnType<typeof callJsonModel>>, pass: string) => JsonObject = (o) => ({ p_result: o.result }),
  failErrorArg: 'p_error' | 'p_error_message' = 'p_error'
) {
  ensureIndependentModels();
  const pass = String(claim.active_pass_kind || '');
  if (!pass) throw new Error('claimed job is missing active_pass_kind');
  try {
    const input = await rpc<JsonObject>(inputRpc, { p_job_id: claim.id, p_lease_token: claim.lease_token });
    const output = await callJsonModel(modelForPass(pass), systemForPass(pass), input);
    const result = await rpc(storeRpc, {
      p_job_id: claim.id,
      p_lease_token: claim.lease_token,
      p_pass_kind: pass,
      p_model: output.model,
      p_provider_response_id: output.providerResponseId,
      p_prompt_sha256: output.promptSha256,
      p_response_sha256: output.responseSha256,
      ...extraStoreArgs(output, pass)
    });
    return { claimed: 1, pass, result };
  } catch (error) {
    await rpc(failRpc, {
      p_job_id: claim.id,
      p_lease_token: claim.lease_token,
      [failErrorArg]: message(error),
      p_retryable: !message(error).includes('not configured')
    }).catch(() => null);
    throw error;
  }
}

const DUPLICATE_SYSTEM = (pass: string) => [
  `You are the ${pass} in a strict duplicate-audit pipeline for Japanese newspaper articles.`,
  'Use only the two verified OCR article texts supplied by the database.',
  'Decide whether they are distinct articles, duplicate representations of the same article, or unresolved.',
  'Do not use headlines, external knowledge, embeddings, or unstated facts.',
  'Return JSON only: {"disposition":"distinct|duplicate|unresolved","confidence":0..1,"reason":"grounded concise reason"}.',
  'Use duplicate/distinct only when confidence is at least 0.85; otherwise use unresolved.'
].join('\n');

export async function runVerifiedDuplicateReviewStep() {
  ensureIndependentModels();
  const runId = await rpc<string>('create_source_grounded_duplicate_audit_run_v6');
  const { data: run, error: runError } = await supabaseAdmin.from('source_grounded_duplicate_audit_runs_v5').select('status').eq('id', runId).maybeSingle();
  if (runError) throw runError;
  if (run?.status === 'queued' || run?.status === 'running') {
    await rpc('populate_source_grounded_duplicate_candidates_v6', { p_run_id: runId });
  }
  const claim = firstClaim(await rpc('claim_source_grounded_duplicate_review_job_v7', { p_lease_seconds: 240 }));
  if (!claim) return { claimed: 0 };
  const pass = String(claim.active_pass_kind || '');
  try {
    const input = await rpc<JsonObject>('get_source_grounded_duplicate_review_input_v7', { p_job_id: claim.id, p_lease_token: claim.lease_token });
    const output = await callJsonModel(modelForPass(pass), DUPLICATE_SYSTEM(pass), input);
    const disposition = String(output.result.disposition || '');
    const confidence = Number(output.result.confidence);
    const reason = String(output.result.reason || '');
    const result = await rpc<JsonObject>('store_source_grounded_duplicate_review_v7', {
      p_job_id: claim.id,
      p_lease_token: claim.lease_token,
      p_pass_kind: pass,
      p_model: output.model,
      p_provider_response_id: output.providerResponseId,
      p_prompt_sha256: output.promptSha256,
      p_response_sha256: output.responseSha256,
      p_disposition: disposition,
      p_confidence: confidence,
      p_reason: reason
    });
    if (result.status === 'completed') {
      try {
        await rpc('finalize_source_grounded_duplicate_audit_v7', { p_run_id: String(claim.run_id || runId) });
      } catch (finalizeError) {
        if (!message(finalizeError).includes('pair_jobs_incomplete')) throw finalizeError;
      }
    }
    return { claimed: 1, pass, result };
  } catch (error) {
    await rpc('fail_source_grounded_duplicate_review_job_v7', {
      p_job_id: claim.id,
      p_lease_token: claim.lease_token,
      p_error: message(error),
      p_retryable: !message(error).includes('not configured')
    }).catch(() => null);
    throw error;
  }
}

const CLASSIFICATION_SYSTEM = (pass: string) => [
  `You are the ${pass} in an independent two-pass category classification pipeline.`,
  'The ONLY article evidence is verified_crop_ocr_text supplied by the database. Ignore all outside knowledge.',
  'Use only category IDs in category_catalog. Do not force a category when evidence is insufficient.',
  'Every source_anchor must be an exact contiguous quote from verified_crop_ocr_text and at least 6 characters.',
  'Return JSON only with classification_status=categorized|no_matching_category, primary_category, confidence, reason, source_anchor, consumer_scene, market_signal, product_type, consumer_need, memberships.',
  'For categorized, memberships is an array of {category_id,score,confidence,source_anchor,reason}; primary_category must be one of them.',
  'For no_matching_category, primary_category must be null and memberships must be empty.'
].join('\n');

export async function runVerifiedClassificationStep() {
  await rpc('enqueue_article_classification_jobs_v6');
  const claim = firstClaim(await rpc('claim_article_classification_job_v6', { p_lease_seconds: 240 }));
  if (!claim) return { claimed: 0 };
  return runJsonPass(
    claim,
    'get_article_classification_input_v6',
    'store_article_classification_pass_v6',
    'fail_article_classification_job_v6',
    CLASSIFICATION_SYSTEM,
    undefined,
    'p_error_message'
  );
}

const ARTICLE_REVIEW_SYSTEM = (pass: string) => pass === 'critic' ? [
  'You are the critic in a strict whole-article review pipeline.',
  'Evaluate reviewer_output only against verified_crop_ocr_text. Do not add new facts or theme seeds.',
  'Return JSON only: {"verdict":"approved|rejected|unresolved","fact_supported":boolean,"coverage_complete":boolean,"no_theme_signal_valid":boolean,"seeds_grounded":boolean,"overclaim_risk":boolean,"reason":"..."}.',
  'Approve only if all factual claims, coverage anchors, no-theme decision, and theme seeds are grounded in the verified OCR.'
].join('\n') : [
  'You are the reviewer in a strict whole-article review pipeline.',
  'Use only verified_crop_ocr_text. Read the whole article, not only its opening.',
  'Return JSON only with: subject, measurement, observed_fact, observed_fact_anchor, limitation, consumer_relevance, no_theme_signal, no_theme_signal_reason, coverage_anchors, theme_seeds.',
  'subject must be one of consumer|company|market|expert|regulator|worker|mixed|unclear.',
  'measurement must be one of survey|purchase|usage|consumer_quote|observation|sales|market_data|launch|announcement|operational_change|financial_result|forecast|experiment|other.',
  'Every anchor must be an exact contiguous quote from the verified OCR and at least 6 characters.',
  'Coverage anchors must cover the article globally: the database will require 1 anchor for short text, one in each half for medium text, or one in each third for long text.',
  'If no defensible theme signal exists set no_theme_signal=true, explain why, and return zero theme_seeds.',
  'Otherwise return one or more theme_seeds with seed_label, seed_statement, subject, measurement, confidence 0..1, source_anchor.'
].join('\n');

export async function runVerifiedArticleReviewStep() {
  await rpc('enqueue_verified_article_review_jobs_v6');
  const claim = firstClaim(await rpc('claim_verified_article_review_job_v6', { p_lease_seconds: 240 }));
  if (!claim) return { claimed: 0 };
  return runJsonPass(
    claim,
    'get_verified_article_review_input_v6',
    'store_verified_article_review_pass_v6',
    'fail_verified_article_review_job_v6',
    ARTICLE_REVIEW_SYSTEM
  );
}

const THEME_CHUNK_SYSTEM = (pass: string) => pass === 'critic' ? [
  'You are the critic for local theme proposals generated from a seed chunk.',
  'Review every supplied proposal and verify that the proposal set covers every supplied seed without omission.',
  'Return JSON only: {"proposal_reviews":[{"proposal_key":"...","verdict":"approved|rejected|unresolved","reason":"..."}],"coverage_complete":boolean,"missing_seed_ids":["uuid"]}.',
  'Do not create new proposals.'
].join('\n') : [
  'You are the synthesizer for one chunk of verified article-level theme seeds.',
  'Every seed must belong to exactly one or more defensible local proposals; no seed may be silently dropped.',
  'Do not infer beyond the supplied seed statements and anchors.',
  'Return JSON only: {"proposals":[{"proposal_key":"stable local key","title":"...","definition":"...","scope_boundary":"...","subject":"...","measurement":"...","support_seed_ids":["uuid"]}]}.',
  'subject and measurement must use the supplied controlled vocabularies. The union of support_seed_ids must cover all seeds in the chunk.'
].join('\n');

const THEME_CONSOLIDATION_SYSTEM = (pass: string) => pass === 'critic' ? [
  'You are the critic for global theme consolidation.',
  'Review every proposed group, detect any remaining cross-group merge collision, and verify complete proposal coverage.',
  'Return JSON only: {"group_reviews":[{"group_key":"...","approved":boolean,"reason":"..."}],"cross_group_merge_pairs":[],"coverage_complete":boolean}.',
  'Do not invent groups or proposals.'
].join('\n') : [
  'You are the global consolidator for all local theme proposals.',
  'Partition every supplied proposal into a complete, non-overlapping set of global theme groups.',
  'Preserve subject/measurement distinctions when merging would erase materially different evidence.',
  'Return JSON only: {"groups":[{"group_key":"stable key","title":"...","definition":"...","inclusion_rule":"...","exclusion_rule":"...","subject":"...","measurement":"...","proposal_ids":["uuid"]}]}.',
  'Every proposal_id must appear exactly once across the groups.'
].join('\n');

export async function runVerifiedThemeCandidateStep() {
  await rpc('create_verified_theme_analysis_run_v7', { p_seed_chunk_size: 40 });
  const chunk = firstClaim(await rpc('claim_verified_theme_seed_chunk_job_v7', { p_lease_seconds: 240 }));
  if (chunk) {
    return runJsonPass(
      chunk,
      'get_verified_theme_seed_chunk_input_v7',
      'store_verified_theme_seed_chunk_pass_v7',
      'fail_verified_theme_seed_chunk_job_v7',
      THEME_CHUNK_SYSTEM
    );
  }
  const consolidation = firstClaim(await rpc('claim_verified_theme_consolidation_job_v7', { p_lease_seconds: 240 }));
  if (consolidation) {
    return runJsonPass(
      consolidation,
      'get_verified_theme_consolidation_input_v7',
      'store_verified_theme_consolidation_pass_v7',
      'fail_verified_theme_consolidation_job_v7',
      THEME_CONSOLIDATION_SYSTEM
    );
  }
  return { claimed: 0 };
}

const CENSUS_SYSTEM = (pass: string) => [
  `You are the ${pass} in an independent full-census mapping pass.`,
  'Evaluate EVERY supplied article against EVERY supplied candidate. Do not sample, omit, or collapse any article-candidate cell.',
  'Use only verified_crop_ocr_text and the supplied candidate definitions/inclusion/exclusion rules.',
  'For EACH article return one decision for EACH candidate_id, exactly once, using relation support|counter|related_not_supporting|none.',
  'support means the article directly supports the theme; counter means directly contradicts or materially challenges it; related_not_supporting is relevant context but not support; none means no defensible relation.',
  'For support or counter use confidence >=0.80 and an exact contiguous source_anchor of at least 6 characters. For related_not_supporting use confidence >=0.75 and the same anchor rule. For none use confidence >=0.70 and source_anchor must be the empty string.',
  'Every reason must be evidence-grounded and at least minimally explanatory. Never invent or paraphrase an anchor.',
  'Return JSON only: {"articles":[{"article_id":"uuid","decisions":[{"candidate_id":"uuid","relation":"support|counter|related_not_supporting|none","confidence":0..1,"source_anchor":"exact quote or empty for none","reason":"..."}]}]}.',
  'The database requires the complete article x candidate matrix and exact mapper/critic agreement on relation for every cell; make this pass independently from the evidence.'
].join('\n');

export async function runVerifiedThemeCensusStep() {
  await rpc('enqueue_verified_theme_census_v7', { p_article_batch_size: 10 });
  const claim = firstClaim(await rpc('claim_verified_theme_census_batch_v7', { p_lease_seconds: 240 }));
  if (!claim) return { claimed: 0 };
  ensureIndependentModels();
  const pass = String(claim.active_pass_kind || '');
  try {
    const input = await rpc<JsonObject>('get_verified_theme_census_input_v7', { p_batch_id: claim.id, p_lease_token: claim.lease_token });
    const output = await callJsonModel(modelForPass(pass), CENSUS_SYSTEM(pass), input);
    const result = await rpc('store_verified_theme_census_pass_v7', {
      p_batch_id: claim.id,
      p_lease_token: claim.lease_token,
      p_pass_kind: pass,
      p_model: output.model,
      p_provider_response_id: output.providerResponseId,
      p_prompt_sha256: output.promptSha256,
      p_response_sha256: output.responseSha256,
      p_result: output.result
    });
    return { claimed: 1, pass, result };
  } catch (error) {
    await rpc('fail_verified_theme_census_batch_v7', {
      p_batch_id: claim.id,
      p_lease_token: claim.lease_token,
      p_error: message(error),
      p_retryable: !message(error).includes('not configured')
    }).catch(() => null);
    throw error;
  }
}

const REPORT_NOTE_SYSTEM = (pass: string) => pass === 'critic' ? [
  'You are the critic for one theme report note.',
  'Check generator_output against deterministic metric values and deterministic evidence only.',
  'Return JSON only: {"approved":boolean,"evidence_supported":boolean,"trend_consistent":boolean,"limitation_adequate":boolean,"counterevidence_handled":boolean,"overclaim_risk":boolean,"reason":"..."}.',
  'Set counterevidence_handled=true only when any supplied counter evidence is explicitly handled by the generator note and its evidence_article_ids. Do not rewrite or introduce numbers.'
].join('\n') : [
  'You generate a qualitative note for one verified theme in direct service of report_request.user_query.',
  'All official numbers are already supplied in metric and must NOT be reproduced or invented in free-form prose.',
  'Use only deterministic_evidence article IDs for citations. If support evidence exists include support evidence; if counter evidence exists include counter evidence and reflect it in interpretation or limitation.',
  'Return JSON only: {"interpretation":"qualitative interpretation with no digits","trajectory_interpretation":"qualitative trajectory with no digits","limitation":"material limitation with no digits","evidence_article_ids":["uuid"]}.',
  'Do not use any article outside deterministic_evidence.'
].join('\n');

const REPORT_FINAL_SYSTEM = (pass: string) => pass === 'critic' ? [
  'You are the final report critic.',
  'Check generator_output for complete candidate coverage, consistency with database metrics, evidence scope, and overclaim risk.',
  'Return JSON only: {"approved":boolean,"coverage_complete":boolean,"metrics_consistent":boolean,"evidence_scope_valid":boolean,"overclaim_risk":boolean,"reason":"..."}.',
  'Do not add or rewrite report content.'
].join('\n') : [
  'You generate only the qualitative synthesis layer of a verified theme report, answering report_request.user_query.',
  'Official numerical metrics are supplied separately and must NOT be generated or repeated in free-form text.',
  'Cover every supplied theme candidate exactly once through coverage_candidate_ids.',
  'major_theme_ids may only contain supplied candidate IDs with positive support.',
  'Cross-theme observations must reference at least two candidate IDs and contain no digits.',
  'Return JSON only: {"executive_summary":"no digits","major_theme_ids":["uuid"],"coverage_candidate_ids":["uuid"],"cross_theme_observations":[{"candidate_ids":["uuid","uuid"],"statement":"no digits","limitation":"no digits"}]}.',
  'Do not invent any number, article, theme, or causal claim.'
].join('\n');

async function runReportNoteStep(sourceJobId: string) {
  const claim = firstClaim(await rpc('claim_verified_theme_report_note_job_v15', { p_source_job_id: sourceJobId, p_lease_seconds: 240 }));
  if (!claim) return null;
  return runJsonPass(
    claim,
    'get_verified_theme_report_note_input_v8',
    'store_verified_theme_report_note_pass_v8',
    'fail_verified_theme_report_note_job_v8',
    REPORT_NOTE_SYSTEM
  );
}

async function runReportFinalStep(sourceJobId: string) {
  const claim = firstClaim(await rpc('claim_verified_theme_report_final_job_v15', { p_source_job_id: sourceJobId, p_lease_seconds: 240 }));
  if (!claim) return null;
  return runJsonPass(
    claim,
    'get_verified_theme_report_final_input_v8',
    'store_verified_theme_report_final_pass_v8',
    'fail_verified_theme_report_final_job_v8',
    REPORT_FINAL_SYSTEM
  );
}

export async function runVerifiedThemeReportStep(sourceJobId: string) {
  if (!sourceJobId.trim()) throw new Error('source_job_id is required for verified report v15');
  const runId = await rpc<string>('create_verified_theme_report_run_v15', { p_source_job_id: sourceJobId });
  const note = await runReportNoteStep(sourceJobId);
  if (note) return { stage: 'note', run_id: runId, ...note };
  const final = await runReportFinalStep(sourceJobId);
  if (final) {
    const result = isObject(final.result) ? final.result : null;
    const reportId = result && typeof result.report_id === 'string' ? result.report_id : '';
    const publishedReportId = reportId
      ? await rpc<string>('publish_verified_theme_report_to_chat_v15', { p_source_job_id: sourceJobId, p_verified_report_id: reportId })
      : null;
    return { stage: 'final', run_id: runId, published_report_id: publishedReportId, ...final };
  }
  return { claimed: 0, run_id: runId };
}
