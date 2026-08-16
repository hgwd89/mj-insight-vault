import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;
type PassKind = 'generator' | 'critic';

class StructuralOutputError extends Error {}
class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const CALL_TIMEOUT_MS = 150_000;
const DIGIT_RE = /[0-9０-９]/;

const NOTE_FORMAT = {
  type: 'json_schema',
  name: 'mj_verified_theme_note_v15',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['interpretation', 'trajectory_interpretation', 'limitation', 'evidence_article_ids'],
    properties: {
      interpretation: { type: 'string' },
      trajectory_interpretation: { type: 'string' },
      limitation: { type: 'string' },
      evidence_article_ids: { type: 'array', items: { type: 'string' } }
    }
  }
} as const;

const NOTE_CRITIC_FORMAT = {
  type: 'json_schema',
  name: 'mj_verified_theme_note_critic_v15',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['approved', 'evidence_supported', 'trend_consistent', 'limitation_adequate', 'counterevidence_handled', 'overclaim_risk', 'reason'],
    properties: {
      approved: { type: 'boolean' },
      evidence_supported: { type: 'boolean' },
      trend_consistent: { type: 'boolean' },
      limitation_adequate: { type: 'boolean' },
      counterevidence_handled: { type: 'boolean' },
      overclaim_risk: { type: 'boolean' },
      reason: { type: 'string' }
    }
  }
} as const;

const FINAL_FORMAT = {
  type: 'json_schema',
  name: 'mj_verified_theme_report_final_v15',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['executive_summary', 'major_theme_ids', 'coverage_candidate_ids', 'cross_theme_observations'],
    properties: {
      executive_summary: { type: 'string' },
      major_theme_ids: { type: 'array', items: { type: 'string' } },
      coverage_candidate_ids: { type: 'array', items: { type: 'string' } },
      cross_theme_observations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['candidate_ids', 'statement', 'limitation'],
          properties: {
            candidate_ids: { type: 'array', minItems: 2, items: { type: 'string' } },
            statement: { type: 'string' },
            limitation: { type: 'string' }
          }
        }
      }
    }
  }
} as const;

const FINAL_CRITIC_FORMAT = {
  type: 'json_schema',
  name: 'mj_verified_theme_report_final_critic_v15',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['approved', 'coverage_complete', 'metrics_consistent', 'evidence_scope_valid', 'overclaim_risk', 'reason'],
    properties: {
      approved: { type: 'boolean' },
      coverage_complete: { type: 'boolean' },
      metrics_consistent: { type: 'boolean' },
      evidence_scope_valid: { type: 'boolean' },
      overclaim_risk: { type: 'boolean' },
      reason: { type: 'string' }
    }
  }
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown) { return value == null ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return text(error.message || error.error || error.details);
  return text(error) || 'verified theme report v15 worker failed';
}
function outputText(value: unknown) {
  const row = value as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (row?.output_text?.trim()) return row.output_text.trim();
  return (row?.output || []).flatMap((item) => item.content || []).map((item) => text(item.text)).filter(Boolean).join('\n').trim();
}
function modelPair(primaryEnv: string, criticEnv: string) {
  const primary = process.env[primaryEnv]?.trim() || TEXT_MODEL;
  const critic = process.env[criticEnv]?.trim() || (primary === 'gpt-4.1' ? 'gpt-4o' : 'gpt-4.1');
  if (!primary || !critic || primary === critic) throw new StructuralOutputError(`${primaryEnv} and ${criticEnv} must be configured and distinct.`);
  return { primary, critic };
}

async function callJson(model: string, instructions: string, userText: string, format: unknown, maxTokens: number) {
  const key = getOpenAIKey();
  if (!key) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');
  const promptSha = sha256([model, instructions, userText].join('\n---\n'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model, store: false, max_output_tokens: maxTokens, instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
        text: { format }
      })
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(`OpenAI Responses API failed: ${response.status} ${response.statusText} ${raw.slice(0, 1800)}`, response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
    const json = JSON.parse(raw) as JsonRecord;
    const providerResponseId = text(json.id);
    const output = outputText(json);
    if (!providerResponseId || !output) throw new ProviderError('OpenAI report receipt or output is missing.', true);
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { throw new StructuralOutputError('Report JSON output invalid.'); }
    return { value: parsed, providerResponseId, promptSha, responseSha: sha256(raw) };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof StructuralOutputError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ProviderError('OpenAI report request timed out.', true);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function noteInstructions(pass: PassKind) {
  if (pass === 'generator') return [
    'You write one evidence-bounded theme note for a verified newspaper corpus.',
    'Use only the supplied deterministic DB metric row and deterministic evidence articles.',
    'The quantitative metric fields are authoritative DB calculations. Do not reproduce, round, infer, or generate any numeric value in free-form prose.',
    'Do not write numerals, percentages, counts, dates, rankings, or quantitative estimates in interpretation, trajectory_interpretation, or limitation.',
    'Interpretation explains qualitative meaning. trajectory_interpretation describes direction cautiously and only when consistent with the DB metric. limitation states the strongest material limitation.',
    'evidence_article_ids may contain only article IDs from deterministic_evidence.',
    'When support evidence exists, include at least one support article ID. When counter evidence exists, include at least one counter article ID.',
    'Return only JSON.'
  ].join('\n');
  return [
    'You independently audit one generated theme note against the same authoritative DB metric and deterministic evidence.',
    'Approve only if prose is fully evidence-supported, qualitatively consistent with DB trend fields, contains an adequate limitation, and cites only deterministic evidence IDs.',
    'If counter evidence exists, counterevidence_handled may be true only when the generator included and materially handled counter evidence.',
    'Do not repair the note. Reject it if material problems remain.',
    'Return only JSON.'
  ].join('\n');
}

function finalInstructions(pass: PassKind) {
  if (pass === 'generator') return [
    'You synthesize the final qualitative report from authoritative DB theme metrics and already verified theme notes.',
    'All quantitative values belong to structured DB metrics, not generated prose. Do not reproduce, round, infer, or generate numeric values in executive_summary, cross-theme statements, or limitations.',
    'Do not write numerals, percentages, counts, dates, rankings, or quantitative estimates in free-form prose.',
    'coverage_candidate_ids must contain every supplied candidate_id exactly once.',
    'major_theme_ids may contain only candidates with actual support in supplied DB metrics.',
    'Cross-theme observations must reference at least two candidate IDs and be supported by supplied notes/metrics; state a limitation for each observation.',
    'Return only JSON.'
  ].join('\n');
  return [
    'You independently audit the final generated synthesis against all authoritative DB metrics and verified theme notes.',
    'Approve only if every candidate is covered, qualitative claims are consistent with DB metrics, evidence scope is valid, and there is no material overclaim.',
    'Do not repair the synthesis. Reject it if material problems remain.',
    'Return only JSON.'
  ].join('\n');
}

function validateNote(value: unknown, metric: unknown, evidence: unknown[]) {
  if (!isRecord(value) || text(value.interpretation).length < 8 || text(value.trajectory_interpretation).length < 4 || text(value.limitation).length < 4 || !Array.isArray(value.evidence_article_ids)) throw new StructuralOutputError('theme note generator schema invalid');
  if (DIGIT_RE.test(text(value.interpretation)) || DIGIT_RE.test(text(value.trajectory_interpretation)) || DIGIT_RE.test(text(value.limitation))) throw new StructuralOutputError('numeric prose forbidden in theme note');
  const allowed = new Set(evidence.map((item) => isRecord(item) ? text(item.article_id) : '').filter(Boolean));
  const relations = new Map(evidence.map((item) => [isRecord(item) ? text(item.article_id) : '', isRecord(item) ? text(item.relation) : '']));
  const seen = new Set<string>();
  for (const raw of value.evidence_article_ids) {
    const id = text(raw);
    if (!allowed.has(id) || seen.has(id)) throw new StructuralOutputError('theme note evidence IDs invalid');
    seen.add(id);
  }
  const row = isRecord(metric) ? metric : {};
  const support = Number(row.support_article_count || 0);
  const counter = Number(row.counter_article_count || 0);
  if (support > 0 && !Array.from(seen).some((id) => relations.get(id) === 'support')) throw new StructuralOutputError('theme note support evidence required');
  if (counter > 0 && !Array.from(seen).some((id) => relations.get(id) === 'counter')) throw new StructuralOutputError('theme note counter evidence required');
  return value;
}

function validateNoteCritic(value: unknown) {
  if (!isRecord(value)
    || typeof value.approved !== 'boolean'
    || typeof value.evidence_supported !== 'boolean'
    || typeof value.trend_consistent !== 'boolean'
    || typeof value.limitation_adequate !== 'boolean'
    || typeof value.counterevidence_handled !== 'boolean'
    || typeof value.overclaim_risk !== 'boolean'
    || text(value.reason).length < 4) throw new StructuralOutputError('theme note critic invalid');
  return value;
}

function validateFinal(value: unknown, metrics: unknown[]) {
  if (!isRecord(value) || text(value.executive_summary).length < 12 || !Array.isArray(value.major_theme_ids) || !Array.isArray(value.coverage_candidate_ids) || !Array.isArray(value.cross_theme_observations)) throw new StructuralOutputError('final report generator schema invalid');
  if (DIGIT_RE.test(text(value.executive_summary))) throw new StructuralOutputError('numeric prose forbidden in executive summary');
  const candidateIds = new Set(metrics.map((item) => isRecord(item) ? text(item.candidate_id) : '').filter(Boolean));
  const supportIds = new Set(metrics.filter((item) => isRecord(item) && Number(item.support_article_count || 0) > 0).map((item) => text((item as JsonRecord).candidate_id)));
  const coverage = new Set<string>();
  for (const raw of value.coverage_candidate_ids) {
    const id = text(raw);
    if (!candidateIds.has(id) || coverage.has(id)) throw new StructuralOutputError('coverage candidate IDs invalid');
    coverage.add(id);
  }
  if (coverage.size !== candidateIds.size) throw new StructuralOutputError('coverage candidate set incomplete');
  const majors = new Set<string>();
  for (const raw of value.major_theme_ids) {
    const id = text(raw);
    if (!supportIds.has(id) || majors.has(id)) throw new StructuralOutputError('major theme IDs invalid');
    majors.add(id);
  }
  for (const raw of value.cross_theme_observations) {
    if (!isRecord(raw) || !Array.isArray(raw.candidate_ids) || raw.candidate_ids.length < 2 || text(raw.statement).length < 8 || text(raw.limitation).length < 4 || DIGIT_RE.test(text(raw.statement)) || DIGIT_RE.test(text(raw.limitation))) throw new StructuralOutputError('cross-theme observation invalid');
    const local = new Set<string>();
    for (const candidate of raw.candidate_ids) {
      const id = text(candidate);
      if (!candidateIds.has(id) || local.has(id)) throw new StructuralOutputError('cross-theme candidate IDs invalid');
      local.add(id);
    }
  }
  return value;
}

function validateFinalCritic(value: unknown) {
  if (!isRecord(value)
    || typeof value.approved !== 'boolean'
    || typeof value.coverage_complete !== 'boolean'
    || typeof value.metrics_consistent !== 'boolean'
    || typeof value.evidence_scope_valid !== 'boolean'
    || typeof value.overclaim_risk !== 'boolean'
    || text(value.reason).length < 4) throw new StructuralOutputError('final report critic invalid');
  return value;
}

async function ensureRun(sourceJobId: string) {
  const { data: gate, error: gateError } = await supabaseAdmin.from('verified_theme_analysis_gate_v8').select('analysis_gate').maybeSingle();
  if (gateError) throw gateError;
  if (!gate || gate.analysis_gate !== 'passed') return null;
  const { data, error } = await supabaseAdmin.rpc('create_verified_theme_report_run_v15', { p_source_job_id: sourceJobId });
  if (error) throw error;
  return text(data);
}

async function loadRun(runId: string) {
  const { data, error } = await supabaseAdmin.from('verified_theme_report_runs_v8').select('*').eq('id', runId).single();
  if (error) throw error;
  return data as JsonRecord;
}

async function claimNote(sourceJobId: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_verified_theme_report_note_job_v15', { p_source_job_id: sourceJobId, p_lease_seconds: 240 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job = { id: text(row.id), runId: text(row.run_id), candidateId: text(row.candidate_id), pass: text(row.active_pass_kind) as PassKind, token: text(row.lease_token) };
  if (!job.id || !job.runId || !job.candidateId || !job.token || !['generator', 'critic'].includes(job.pass)) throw new StructuralOutputError('claimed report note v15 job invalid');
  return job;
}

async function claimFinal(sourceJobId: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_verified_theme_report_final_job_v15', { p_source_job_id: sourceJobId, p_lease_seconds: 240 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job = { id: text(row.id), runId: text(row.run_id), pass: text(row.active_pass_kind) as PassKind, token: text(row.lease_token) };
  if (!job.id || !job.runId || !job.token || !['generator', 'critic'].includes(job.pass)) throw new StructuralOutputError('claimed final report v15 job invalid');
  return job;
}

async function noteInput(job: NonNullable<Awaited<ReturnType<typeof claimNote>>>) {
  const { data, error } = await supabaseAdmin.rpc('get_verified_theme_report_note_input_v8', { p_job_id: job.id, p_lease_token: job.token });
  if (error) throw error;
  if (!isRecord(data) || !isRecord(data.metric) || !Array.isArray(data.deterministic_evidence)) throw new StructuralOutputError('report note input malformed');
  return { metric: data.metric, evidence: data.deterministic_evidence, generator: data.generator_output };
}

async function finalInput(job: NonNullable<Awaited<ReturnType<typeof claimFinal>>>) {
  const { data, error } = await supabaseAdmin.rpc('get_verified_theme_report_final_input_v8', { p_job_id: job.id, p_lease_token: job.token });
  if (error) throw error;
  if (!isRecord(data) || !Array.isArray(data.theme_metrics) || !Array.isArray(data.theme_notes)) throw new StructuralOutputError('final report input malformed');
  return { metrics: data.theme_metrics, notes: data.theme_notes, generator: data.generator_output };
}

async function storeNote(job: NonNullable<Awaited<ReturnType<typeof claimNote>>>, model: string, response: Awaited<ReturnType<typeof callJson>>, result: unknown) {
  const { data, error } = await supabaseAdmin.rpc('store_verified_theme_report_note_pass_v8', {
    p_job_id: job.id, p_lease_token: job.token, p_pass_kind: job.pass, p_model: model,
    p_provider_response_id: response.providerResponseId, p_prompt_sha256: response.promptSha,
    p_response_sha256: response.responseSha, p_result: result
  });
  if (error) throw error;
  return data;
}

async function storeFinal(job: NonNullable<Awaited<ReturnType<typeof claimFinal>>>, model: string, response: Awaited<ReturnType<typeof callJson>>, result: unknown) {
  const { data, error } = await supabaseAdmin.rpc('store_verified_theme_report_final_pass_v8', {
    p_job_id: job.id, p_lease_token: job.token, p_pass_kind: job.pass, p_model: model,
    p_provider_response_id: response.providerResponseId, p_prompt_sha256: response.promptSha,
    p_response_sha256: response.responseSha, p_result: result
  });
  if (error) throw error;
  return data;
}

async function failNote(job: NonNullable<Awaited<ReturnType<typeof claimNote>>>, errorValue: unknown) {
  const { data, error } = await supabaseAdmin.rpc('fail_verified_theme_report_note_job_v8', {
    p_job_id: job.id, p_lease_token: job.token, p_error: errorMessage(errorValue),
    p_retryable: errorValue instanceof ProviderError ? errorValue.retryable : false
  });
  if (error) throw error;
  return data;
}

async function failFinal(job: NonNullable<Awaited<ReturnType<typeof claimFinal>>>, errorValue: unknown) {
  const { data, error } = await supabaseAdmin.rpc('fail_verified_theme_report_final_job_v8', {
    p_job_id: job.id, p_lease_token: job.token, p_error: errorMessage(errorValue),
    p_retryable: errorValue instanceof ProviderError ? errorValue.retryable : false
  });
  if (error) throw error;
  return data;
}

async function updateChatJob(sourceJobId: string, patch: JsonRecord) {
  const { error } = await supabaseAdmin.from('chat_jobs').update({ ...patch, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', sourceJobId);
  if (error) throw error;
}

async function publishCompletedRun(sourceJobId: string, runId: string) {
  const { data: report, error: reportError } = await supabaseAdmin.from('verified_theme_reports_v8').select('id').eq('run_id', runId).maybeSingle();
  if (reportError) throw reportError;
  const verifiedReportId = text(report?.id);
  if (!verifiedReportId) return { stage: 'report_completed_without_verified_report', run_id: runId, external_calls: 0 };

  const { data: integrity, error: integrityError } = await supabaseAdmin.rpc('verified_theme_report_integrity_v15', { p_report_id: verifiedReportId, p_source_job_id: sourceJobId });
  if (integrityError) throw integrityError;
  if (integrity !== true) {
    await updateChatJob(sourceJobId, { status: 'failed', progress: 100, stage: 'quality_gate', error_message: 'verified_report_v15_integrity_required', finished_at: new Date().toISOString(), next_retry_at: null });
    return { stage: 'report_integrity_blocked', run_id: runId, verified_report_id: verifiedReportId, external_calls: 0 };
  }

  const { data: chatReportId, error: publishError } = await supabaseAdmin.rpc('publish_verified_theme_report_to_chat_v15', { p_source_job_id: sourceJobId, p_verified_report_id: verifiedReportId });
  if (publishError) throw publishError;
  const publishedId = text(chatReportId);
  await updateChatJob(sourceJobId, {
    status: 'completed', progress: 100, stage: 'completed', report_id: publishedId,
    result_json: { verified_report_id: verifiedReportId, chat_report_id: publishedId, report_run_id: runId, contract: 'verified_theme_report_v15' },
    error_message: null, attempt_count: 0, finished_at: new Date().toISOString(), next_retry_at: null,
    lease_token: null, lease_expires_at: null
  });
  return { stage: 'report_published_v15', run_id: runId, verified_report_id: verifiedReportId, chat_report_id: publishedId, external_calls: 0 };
}

async function syncTerminalRun(sourceJobId: string, run: JsonRecord) {
  const status = text(run.status);
  if (status === 'completed') return publishCompletedRun(sourceJobId, text(run.id));
  if (status === 'needs_review' || status === 'failed') {
    await updateChatJob(sourceJobId, { status: 'failed', progress: 100, stage: 'quality_gate', error_message: text(run.error_message) || `verified report run ${status}`, finished_at: new Date().toISOString(), next_retry_at: null, lease_token: null, lease_expires_at: null });
    return { stage: status, run_id: text(run.id), reason: text(run.error_message), external_calls: 0 };
  }
  return null;
}

export async function runVerifiedThemeReportWorkerV15Step(sourceJobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(sourceJobId)) throw new StructuralOutputError('source_job_id is invalid');
  const runId = await ensureRun(sourceJobId);
  if (!runId) return { stage: 'blocked', reason: 'verified_theme_analysis_proof_required', source_job_id: sourceJobId, external_calls: 0 };

  const initial = await loadRun(runId);
  const terminal = await syncTerminalRun(sourceJobId, initial);
  if (terminal) return terminal;

  const note = await claimNote(sourceJobId);
  if (note) {
    let calls = 0;
    try {
      const input = await noteInput(note);
      const models = modelPair('OPENAI_THEME_REPORT_NOTE_MODEL', 'OPENAI_THEME_REPORT_NOTE_CRITIC_MODEL');
      const model = note.pass === 'generator' ? models.primary : models.critic;
      const user = JSON.stringify(note.pass === 'generator'
        ? { task: 'write_verified_theme_note_v15', metric: input.metric, deterministic_evidence: input.evidence }
        : { task: 'criticize_verified_theme_note_v15', metric: input.metric, deterministic_evidence: input.evidence, generator_output: input.generator });
      calls = 1;
      const response = await callJson(model, noteInstructions(note.pass), user, note.pass === 'generator' ? NOTE_FORMAT : NOTE_CRITIC_FORMAT, 5000);
      const result = note.pass === 'generator' ? validateNote(response.value, input.metric, input.evidence) : validateNoteCritic(response.value);
      const saved = await storeNote(note, model, response, result);
      await updateChatJob(sourceJobId, { stage: `verified_report_note_${note.pass}`, progress: 92, error_message: null });
      return { stage: 'theme_report_note_pass_v15', source_job_id: sourceJobId, run_id: note.runId, candidate_id: note.candidateId, job_id: note.id, pass_kind: note.pass, result: saved, external_calls: calls };
    } catch (errorValue) {
      const saved = await failNote(note, errorValue);
      return { stage: 'theme_report_note_failed_v15', source_job_id: sourceJobId, run_id: note.runId, candidate_id: note.candidateId, job_id: note.id, pass_kind: note.pass, error: errorMessage(errorValue), result: saved, external_calls: calls };
    }
  }

  const { error: prepError } = await supabaseAdmin.rpc('prepare_verified_theme_report_final_v8', { p_run_id: runId });
  if (prepError) throw prepError;
  const finalJob = await claimFinal(sourceJobId);
  if (finalJob) {
    let calls = 0;
    try {
      const input = await finalInput(finalJob);
      const models = modelPair('OPENAI_THEME_REPORT_FINAL_MODEL', 'OPENAI_THEME_REPORT_FINAL_CRITIC_MODEL');
      const model = finalJob.pass === 'generator' ? models.primary : models.critic;
      const user = JSON.stringify(finalJob.pass === 'generator'
        ? { task: 'synthesize_verified_theme_report_v15', theme_metrics: input.metrics, theme_notes: input.notes }
        : { task: 'criticize_verified_theme_report_v15', theme_metrics: input.metrics, theme_notes: input.notes, generator_output: input.generator });
      calls = 1;
      const response = await callJson(model, finalInstructions(finalJob.pass), user, finalJob.pass === 'generator' ? FINAL_FORMAT : FINAL_CRITIC_FORMAT, 8000);
      const result = finalJob.pass === 'generator' ? validateFinal(response.value, input.metrics) : validateFinalCritic(response.value);
      const saved = await storeFinal(finalJob, model, response, result);
      await updateChatJob(sourceJobId, { stage: `verified_report_final_${finalJob.pass}`, progress: 97, error_message: null });
      return { stage: 'theme_report_final_pass_v15', source_job_id: sourceJobId, run_id: finalJob.runId, job_id: finalJob.id, pass_kind: finalJob.pass, result: saved, external_calls: calls };
    } catch (errorValue) {
      const saved = await failFinal(finalJob, errorValue);
      return { stage: 'theme_report_final_failed_v15', source_job_id: sourceJobId, run_id: finalJob.runId, job_id: finalJob.id, pass_kind: finalJob.pass, error: errorMessage(errorValue), result: saved, external_calls: calls };
    }
  }

  const fresh = await loadRun(runId);
  const freshTerminal = await syncTerminalRun(sourceJobId, fresh);
  if (freshTerminal) return freshTerminal;
  return { stage: 'idle', source_job_id: sourceJobId, run_id: runId, status: text(fresh.status), external_calls: 0 };
}
