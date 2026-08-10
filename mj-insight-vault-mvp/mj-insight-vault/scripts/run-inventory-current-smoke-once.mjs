import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BRANCH = 'audit/verified-pipeline-v10-buildcheck';
const JOB_ID = '8351828e-33e2-446e-9485-f4d6fa3b2dcd';
const LEASE_SECONDS = 420;
const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || 'gpt-4.1';
const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';

if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) {
  console.log('inventory_build_smoke=skipped_non_target_environment');
  process.exit(0);
}

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
if (!supabaseUrl || !serviceKey || !openaiKey) {
  console.log(JSON.stringify({
    inventory_build_smoke: 'missing_runtime_credentials',
    supabase_url_present: Boolean(supabaseUrl),
    service_role_present: Boolean(serviceKey),
    openai_present: Boolean(openaiKey)
  }));
  process.exit(0);
}
if (mapperModel === criticModel) throw new Error('inventory_build_smoke requires distinct mapper and critic models');

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-client-info': 'mj-inventory-build-smoke-v1' } }
});

const blindSchema = {
  name: 'blind_article_inventory',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    properties: {
      groups: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', additionalProperties: false,
          required: ['group_kind','block_indices','headline_anchor','non_article_role','confidence','reason'],
          properties: {
            group_kind: { type: 'string', enum: ['article','non_article'] },
            block_indices: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
            headline_anchor: { type: 'string' },
            non_article_role: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          }
        }
      }
    }
  }
};

class ValidationError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const rec = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('expected object response','structural');
  return value;
};

function outputText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string' && part.text.trim()) return part.text;
    }
  }
  throw new Error('OpenAI response missing output text');
}

async function structured(model, system, user) {
  const body = {
    model, store: false, max_output_tokens: 12000,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    text: { format: { type: 'json_schema', ...blindSchema } }
  };
  const promptSha256 = sha256(JSON.stringify(body));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI Responses API failed: ${response.status} ${raw.slice(0,300)}`);
  const payload = JSON.parse(raw);
  const providerResponseId = String(payload.id || '');
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('provider receipt is invalid');
  return {
    parsed: JSON.parse(outputText(payload)),
    providerResponseId,
    promptSha256,
    responseSha256: sha256(raw)
  };
}

function parseGroups(parsed, blocks) {
  if (!Array.isArray(parsed?.groups) || !parsed.groups.length) throw new ValidationError('groups array is missing','structural');
  const valid = new Map(blocks.map(b => [b.block_index,b.block_text]));
  const seen = new Set();
  const groups = parsed.groups.map((raw,i) => {
    const g = rec(raw);
    const kind = String(g.group_kind || '');
    if (!['article','non_article'].includes(kind)) throw new ValidationError(`invalid group_kind at ${i}`,'structural');
    if (!Array.isArray(g.block_indices) || !g.block_indices.length) throw new ValidationError(`empty block_indices at ${i}`,'structural');
    const indices = g.block_indices.map(Number);
    for (const idx of indices) {
      if (!Number.isInteger(idx) || !valid.has(idx)) throw new ValidationError(`unknown block index ${idx}`,'structural');
      if (seen.has(idx)) throw new ValidationError(`block ${idx} assigned more than once`,'structural');
      seen.add(idx);
    }
    const headline = String(g.headline_anchor || '').trim();
    const role = String(g.non_article_role || '').trim();
    const confidence = Number(g.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.80) throw new ValidationError(`low confidence group ${confidence}`,'low_confidence');
    if (kind === 'article') {
      if (!headline) throw new ValidationError('headline_anchor missing','structural');
      const needle = headline.replace(/\s+/g,'').toLowerCase();
      if (!indices.some(idx => (valid.get(idx)||'').replace(/\s+/g,'').toLowerCase().includes(needle))) {
        throw new ValidationError('headline_anchor not present in group OCR','structural');
      }
    } else if (!role) throw new ValidationError('non_article_role missing','structural');
    return { group_kind: kind, block_indices: indices, headline_anchor: headline, non_article_role: role, confidence, reason: String(g.reason || '') };
  });
  if (seen.size !== blocks.length) {
    const missing = blocks.filter(b => !seen.has(b.block_index)).map(b => b.block_index);
    throw new ValidationError(`block partition incomplete; omitted=${missing.join(',')}`,'structural');
  }
  return groups;
}

function prompt(job, blocks, passKind, repairReason='') {
  const system = [
    'You are a blind page-level article inventory auditor.',
    'Use only the OCR blocks supplied in this request.',
    'Do not use filenames, upload metadata, frozen article records, article counts, or outputs from another audit pass.',
    'Partition EVERY expected OCR block exactly once into article or non_article groups.',
    'Before returning, verify that union(block_indices) equals expected_block_indices exactly and that no block appears twice.',
    'Article groups must represent distinct editorial articles and include a verbatim headline substring from one of their own OCR blocks.',
    'Non-article groups include mastheads, folios, labels, ads, navigation, decorative text, and other non-editorial material.',
    'Confidence is epistemic. Do not inflate it. If genuinely uncertain, report calibrated confidence; values below 0.80 will route to review.',
    `This is independent blind pass ${passKind}.`,
    repairReason ? `Your immediately previous response for THIS SAME pass failed structural validation: ${repairReason}. Return a corrected fresh partition; do not inflate confidence.` : ''
  ].filter(Boolean).join(' ');
  return {
    system,
    user: JSON.stringify({
      page_identity_source_image_id: job.page_identity_source_image_id,
      source_ocr_json_sha256: job.source_ocr_json_sha256,
      block_count: job.block_count,
      expected_block_indices: blocks.map(b=>b.block_index),
      blocks
    })
  };
}

async function runPass(job, blocks, passKind, model) {
  let p = prompt(job,blocks,passKind);
  let receipt = await structured(model,p.system,p.user);
  try {
    return { receipt, groups: parseGroups(receipt.parsed,blocks), repaired: false };
  } catch (e) {
    if (!(e instanceof ValidationError) || e.kind === 'low_confidence') throw e;
    p = prompt(job,blocks,passKind,e.message);
    receipt = await structured(model,p.system,p.user);
    try {
      return { receipt, groups: parseGroups(receipt.parsed,blocks), repaired: true };
    } catch (repairError) {
      if (repairError instanceof ValidationError && repairError.kind === 'structural') {
        throw new ValidationError(`exhausted repair attempt: ${repairError.message}`,'structural');
      }
      throw repairError;
    }
  }
}

async function rpc(name,args) {
  const { data,error } = await supabase.rpc(name,args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function review(job,reason) {
  return rpc('review_source_page_article_inventory_job_v1', { p_job_id:job.id,p_lease_token:job.lease_token,p_reason:reason.slice(0,3900) });
}

async function cleanupFailure(job,reason) {
  const { data: state } = await supabase.from('source_page_article_inventory_jobs_v1').select('status,lease_token').eq('id',job.id).maybeSingle();
  if (state?.status !== 'running' || state?.lease_token !== job.lease_token) return state || null;
  return rpc('fail_source_page_article_inventory_job_v2', { p_job_id:job.id,p_lease_token:job.lease_token,p_error_message:reason.slice(0,3900),p_retryable:true });
}

let job = null;
try {
  const claim = await rpc('claim_source_page_article_inventory_job_smoke_v1',{p_job_id:JOB_ID,p_lease_seconds:LEASE_SECONDS});
  job = (Array.isArray(claim) ? claim[0] : claim) || null;
  if (!job) {
    console.log(JSON.stringify({inventory_build_smoke:'not_claimed',job_id:JOB_ID}));
    process.exit(0);
  }
  if (job.requires_third_pass) {
    const result = await review(job,'build smoke restricted to non-third-pass jobs');
    console.log(JSON.stringify({inventory_build_smoke:'needs_review',stage:'third_pass',job_id:job.id,result}));
    process.exit(0);
  }

  const { data: blockRows,error:blockError } = await supabase.from('source_ocr_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256')
    .eq('source_image_id',job.inventory_source_image_id).eq('page_index',0)
    .eq('source_ocr_json_sha256',job.source_ocr_json_sha256).order('block_index',{ascending:true});
  if (blockError) throw new Error(blockError.message);
  const blocks = blockRows || [];
  if (blocks.length !== job.block_count) throw new Error(`block count mismatch ${blocks.length}/${job.block_count}`);

  const { data: passRows,error:passError } = await supabase.from('source_page_article_inventory_pass_runs_v1').select('pass_kind').eq('job_id',job.id);
  if (passError) throw new Error(passError.message);
  const passKinds = new Set((passRows||[]).map(r=>String(r.pass_kind)));
  const executed=[];

  for (const [passKind,model] of [['mapper',mapperModel],['critic',criticModel]]) {
    if (passKinds.has(passKind)) continue;
    await rpc('renew_source_page_article_inventory_job_lease_v1',{p_job_id:job.id,p_lease_token:job.lease_token,p_lease_seconds:LEASE_SECONDS});
    let result;
    try {
      result = await runPass(job,blocks,passKind,model);
    } catch (e) {
      if (e instanceof ValidationError) {
        const reviewed = await review(job,`${passKind}: ${e.message}`);
        console.log(JSON.stringify({inventory_build_smoke:'needs_review',job_id:job.id,stage:`blind_${passKind}`,reason_class:e.kind,reason:e.message,reviewed,executed}));
        process.exit(0);
      }
      throw e;
    }
    await rpc('replace_source_page_article_inventory_pass_v1',{
      p_job_id:job.id,p_lease_token:job.lease_token,p_pass_kind:passKind,p_model:model,
      p_provider_response_id:result.receipt.providerResponseId,p_prompt_sha256:result.receipt.promptSha256,
      p_response_sha256:result.receipt.responseSha256,p_groups:result.groups
    });
    executed.push({pass_kind:passKind,model,repaired:result.repaired});
    passKinds.add(passKind);
  }

  await rpc('renew_source_page_article_inventory_job_lease_v1',{p_job_id:job.id,p_lease_token:job.lease_token,p_lease_seconds:LEASE_SECONDS});
  const final = await rpc('finalize_source_page_article_inventory_job_v1',{p_job_id:job.id,p_lease_token:job.lease_token});
  console.log(JSON.stringify({inventory_build_smoke:'finalized',job_id:job.id,final,executed}));
} catch (e) {
  const message = e instanceof Error ? e.message : 'unknown build smoke error';
  let cleanup=null;
  if (job) {
    try { cleanup=await cleanupFailure(job,message); } catch (ce) { cleanup={error:ce instanceof Error?ce.message:'cleanup failed'}; }
  }
  console.log(JSON.stringify({inventory_build_smoke:'error',job_id:job?.id||JOB_ID,error:message,cleanup}));
}
