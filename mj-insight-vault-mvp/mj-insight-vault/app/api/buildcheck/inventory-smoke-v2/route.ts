import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const BRANCH = 'agent/inventory-smoke-v2';
const JOB_ID = '0b5b56fe-1e64-4cff-8432-eb48e9688e55';
const NONCE_SHA256 = 'd67a9891e9364fca7521d00ec12d498db76b9263fc36af53c96a702ff1d1d616';
const LEASE_SECONDS = 240;

type JsonRecord = Record<string, unknown>;
type Job = {
  id: string;
  page_identity_source_image_id: string;
  inventory_source_image_id: string;
  source_ocr_json_sha256: string;
  block_count: number;
  existing_article_count: number;
  requires_third_pass: boolean;
  lease_token: string;
};
type Block = {
  block_index: number;
  block_text: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  ocr_confidence: number;
  source_ocr_json_sha256: string;
};
type Group = {
  group_kind: 'article' | 'non_article';
  block_indices: number[];
  headline_anchor: string;
  non_article_role: string;
  confidence: number;
  reason: string;
};
type Candidate = {
  group_fingerprint: string;
  block_indices: number[];
  headline_anchor: string;
  group_text: string;
};
type FrozenArticle = {
  article_id: string;
  headline: string;
  article_index: number;
  ocr_text: string;
};
type Mapping = {
  group_fingerprint: string;
  article_id: string;
  confidence: number;
  rationale: string;
};

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
} as const;

const mappingSchema = {
  name: 'inventory_article_mapping',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false, required: ['mappings'],
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['group_fingerprint','article_id','confidence','rationale'],
          properties: {
            group_fingerprint: { type: 'string' },
            article_id: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            rationale: { type: 'string' }
          }
        }
      }
    }
  }
} as const;

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }
function record(v: unknown): JsonRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('REVIEW: expected object response');
  return v as JsonRecord;
}
function outputText(payload: JsonRecord) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item0 of output) {
    const item = item0 && typeof item0 === 'object' ? item0 as JsonRecord : {};
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part0 of content) {
      const part = part0 && typeof part0 === 'object' ? part0 as JsonRecord : {};
      if (typeof part.text === 'string' && part.text.trim()) return part.text;
    }
  }
  throw new Error('OpenAI response missing output text');
}
async function callStructured(model: string, system: string, user: string, schema: typeof blindSchema | typeof mappingSchema) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const body = {
    model, store: false, max_output_tokens: 12000,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    text: { format: { type: 'json_schema', ...schema } }
  };
  const promptSha256 = sha256(JSON.stringify(body));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(150000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI Responses API failed: ${response.status} ${raw.slice(0,300)}`);
  const payload = JSON.parse(raw) as JsonRecord;
  const providerResponseId = String(payload.id || '');
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('OpenAI response id is not a real provider receipt');
  const parsed = JSON.parse(outputText(payload)) as JsonRecord;
  return { parsed, providerResponseId, promptSha256, responseSha256: sha256(raw) };
}
async function claim(): Promise<Job | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_smoke_v1', { p_job_id: JOB_ID, p_lease_seconds: LEASE_SECONDS });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as Job | null;
}
async function loadBlocks(job: Job): Promise<Block[]> {
  const { data, error } = await supabaseAdmin.from('source_ocr_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256')
    .eq('source_image_id', job.inventory_source_image_id).eq('page_index',0)
    .eq('source_ocr_json_sha256', job.source_ocr_json_sha256).order('block_index',{ascending:true});
  if (error) throw new Error(error.message);
  const blocks = (data || []) as Block[];
  if (blocks.length !== job.block_count) throw new Error(`REVIEW: block count mismatch ${blocks.length}/${job.block_count}`);
  return blocks;
}
function parseGroups(parsed: JsonRecord, blocks: Block[]): Group[] {
  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) throw new Error('REVIEW: groups array is missing');
  const valid = new Map(blocks.map(b => [b.block_index,b.block_text]));
  const seen = new Set<number>();
  const groups = parsed.groups.map((raw,i) => {
    const g = record(raw);
    const kind = String(g.group_kind || '');
    if (kind !== 'article' && kind !== 'non_article') throw new Error(`REVIEW: invalid group_kind at ${i}`);
    if (!Array.isArray(g.block_indices) || !g.block_indices.length) throw new Error(`REVIEW: empty block_indices at ${i}`);
    const indices = g.block_indices.map(v => Number(v));
    for (const idx of indices) {
      if (!Number.isInteger(idx) || !valid.has(idx)) throw new Error(`REVIEW: unknown block index ${idx}`);
      if (seen.has(idx)) throw new Error(`REVIEW: block ${idx} assigned more than once`);
      seen.add(idx);
    }
    const headline = String(g.headline_anchor || '').trim();
    const role = String(g.non_article_role || '').trim();
    const confidence = Number(g.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.80) throw new Error(`REVIEW: low confidence group ${confidence}`);
    if (kind === 'article') {
      if (!headline) throw new Error('REVIEW: headline_anchor missing');
      const needle = headline.replace(/\s+/g,'').toLowerCase();
      if (!indices.some(idx => (valid.get(idx)||'').replace(/\s+/g,'').toLowerCase().includes(needle))) throw new Error('REVIEW: headline_anchor not in group OCR');
    } else if (!role) throw new Error('REVIEW: non_article_role missing');
    return { group_kind: kind, block_indices: indices, headline_anchor: headline, non_article_role: role, confidence, reason: String(g.reason || '') } as Group;
  });
  if (seen.size !== blocks.length) throw new Error(`REVIEW: block partition incomplete ${seen.size}/${blocks.length}`);
  return groups;
}
async function passKinds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_pass_runs_v1').select('pass_kind').eq('job_id',jobId);
  if (error) throw new Error(error.message);
  return new Set((data||[]).map(r => String(r.pass_kind)));
}
async function storeBlind(job: Job, passKind: 'mapper'|'critic', model: string, receipt: Awaited<ReturnType<typeof callStructured>>, groups: Group[]) {
  const { data, error } = await supabaseAdmin.rpc('replace_source_page_article_inventory_pass_v1', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_pass_kind: passKind, p_model: model,
    p_provider_response_id: receipt.providerResponseId, p_prompt_sha256: receipt.promptSha256,
    p_response_sha256: receipt.responseSha256, p_groups: groups
  });
  if (error) throw new Error(error.message);
  return data;
}
async function yieldJob(job: Job, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2', { p_job_id: job.id, p_lease_token: job.lease_token, p_stage: stage });
  if (error) throw new Error(error.message);
  return data;
}
async function reviewJob(job: Job, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason.slice(0,3900) });
  if (error) throw new Error(`${reason}; review rpc: ${error.message}`);
  return data;
}
async function failJob(job: Job, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', { p_job_id: job.id, p_lease_token: job.lease_token, p_error_message: reason.slice(0,3900), p_retryable: true });
  if (error) throw new Error(`${reason}; fail rpc: ${error.message}`);
  return data;
}
async function candidates(jobId: string): Promise<Candidate[]> {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_consensus_groups_v2')
    .select('group_fingerprint,block_indices,headline_anchor,group_text').eq('job_id',jobId).order('group_fingerprint',{ascending:true});
  if (error) throw new Error(error.message);
  return (data||[]).map(r => ({ group_fingerprint:String(r.group_fingerprint), block_indices:Array.isArray(r.block_indices)?r.block_indices.map(Number):[], headline_anchor:String(r.headline_anchor||''), group_text:String(r.group_text||'') }));
}
async function frozenArticles(job: Job): Promise<FrozenArticle[]> {
  const { data: maps, error: mapError } = await supabaseAdmin.from('source_page_capture_map_v1').select('source_image_id').eq('page_identity_source_image_id',job.page_identity_source_image_id);
  if (mapError) throw new Error(mapError.message);
  const imageIds = Array.from(new Set((maps||[]).map(r => String(r.source_image_id))));
  if (!imageIds.length) throw new Error('REVIEW: page capture map is empty');
  const { data, error } = await supabaseAdmin.from('formal_corpus_articles_v1').select('id,headline,article_index,ocr_text').in('source_image_id',imageIds).order('article_index',{ascending:true});
  if (error) throw new Error(error.message);
  return (data||[]).map(r => ({ article_id:String(r.id), headline:String(r.headline||''), article_index:Number(r.article_index||0), ocr_text:String(r.ocr_text||'') }));
}
function parseMappings(parsed: JsonRecord, cs: Candidate[], arts: FrozenArticle[]): Mapping[] {
  if (!Array.isArray(parsed.mappings)) throw new Error('REVIEW: mappings array missing');
  if (parsed.mappings.length !== cs.length || cs.length !== arts.length) throw new Error('REVIEW: mapping row count mismatch');
  const gs = new Set(cs.map(c=>c.group_fingerprint)); const as = new Set(arts.map(a=>a.article_id));
  const seenG = new Set<string>(); const seenA = new Set<string>();
  return parsed.mappings.map((raw,i) => {
    const m=record(raw); const g=String(m.group_fingerprint||''); const a=String(m.article_id||''); const confidence=Number(m.confidence);
    if (!gs.has(g)||seenG.has(g)) throw new Error(`REVIEW: invalid or duplicate group mapping ${i}`);
    if (!as.has(a)||seenA.has(a)) throw new Error(`REVIEW: invalid or duplicate article mapping ${i}`);
    if (!Number.isFinite(confidence)||confidence<0.80) throw new Error(`REVIEW: low mapping confidence ${confidence}`);
    seenG.add(g);seenA.add(a); return {group_fingerprint:g,article_id:a,confidence,rationale:String(m.rationale||'')};
  });
}
async function mappingPassKinds(jobId:string) {
  const {data,error}=await supabaseAdmin.from('source_page_article_inventory_mapping_pass_runs_v2').select('pass_kind').eq('job_id',jobId);
  if(error) throw new Error(error.message); return new Set((data||[]).map(r=>String(r.pass_kind)));
}
async function storeMapping(job:Job, passKind:'mapper'|'critic', model:string, receipt:Awaited<ReturnType<typeof callStructured>>, mappings:Mapping[]) {
  const {data,error}=await supabaseAdmin.rpc('replace_inventory_mapping_pass_v2',{
    p_job_id:job.id,p_lease_token:job.lease_token,p_pass_kind:passKind,p_model:model,
    p_provider_response_id:receipt.providerResponseId,p_prompt_sha256:receipt.promptSha256,p_response_sha256:receipt.responseSha256,p_mappings:mappings
  });
  if(error) throw new Error(error.message); return data;
}
async function finalize(job:Job) {
  const {data,error}=await supabaseAdmin.rpc('finalize_source_page_article_inventory_job_v1',{p_job_id:job.id,p_lease_token:job.lease_token});
  if(error) throw new Error(`REVIEW: ${error.message}`); return data;
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found',{status:404});
  const job = await claim();
  if (!job) {
    const {data}=await supabaseAdmin.from('source_page_article_inventory_jobs_v1').select('id,status,attempt_count,error_message,finished_at').eq('id',JOB_ID).single();
    return Response.json({claimed:0,job:data},{headers:{'cache-control':'no-store'}});
  }
  try {
    const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || 'gpt-4.1';
    const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';
    const mappingMapperModel = process.env.OPENAI_INVENTORY_MAPPING_MAPPER_MODEL || 'gpt-4o-mini';
    const mappingCriticModel = process.env.OPENAI_INVENTORY_MAPPING_CRITIC_MODEL || 'gpt-4o';
    if (mapperModel === criticModel) throw new Error('REVIEW: blind inventory independent models are identical');
    if (mappingMapperModel === mappingCriticModel) throw new Error('REVIEW: mapping independent models are identical');
    const blocks = await loadBlocks(job);
    const kinds = await passKinds(job.id);
    if (!kinds.has('mapper')) {
      const system='You are the mapper in a blind page-level article inventory audit. Use only the OCR blocks supplied. Partition every OCR block exactly once into distinct editorial article groups or non_article groups. Do not use any existing article list, filename, upload metadata, or prior output. For each article group, headline_anchor must be a verbatim substring from one of that group’s OCR blocks. Non_article includes mastheads, folios, labels, ads, navigation, captions not belonging to editorial article text, and decorative material. Return calibrated confidence; formal groups require confidence at least 0.80.';
      const receipt=await callStructured(mapperModel,system,JSON.stringify({job:{block_count:job.block_count,source_ocr_json_sha256:job.source_ocr_json_sha256},blocks}),blindSchema);
      const groups=parseGroups(receipt.parsed,blocks); await storeBlind(job,'mapper',mapperModel,receipt,groups);
      return Response.json({claimed:1,stage:'blind_mapper',job_id:job.id,yield:await yieldJob(job,'blind_mapper')},{headers:{'cache-control':'no-store'}});
    }
    if (!kinds.has('critic')) {
      const system='You are the critic in an independent blind page-level article inventory audit. Use only the OCR blocks supplied. Independently partition every OCR block exactly once into distinct editorial article groups or non_article groups. Do not use any existing article list, filename, upload metadata, mapper output, or prior output. For each article group, headline_anchor must be a verbatim substring from one of that group’s OCR blocks. Non_article includes mastheads, folios, labels, ads, navigation, captions not belonging to editorial article text, and decorative material. Return calibrated confidence; formal groups require confidence at least 0.80.';
      const receipt=await callStructured(criticModel,system,JSON.stringify({job:{block_count:job.block_count,source_ocr_json_sha256:job.source_ocr_json_sha256},blocks}),blindSchema);
      const groups=parseGroups(receipt.parsed,blocks); await storeBlind(job,'critic',criticModel,receipt,groups);
      return Response.json({claimed:1,stage:'blind_critic',job_id:job.id,yield:await yieldJob(job,'blind_critic')},{headers:{'cache-control':'no-store'}});
    }
    const cs=await candidates(job.id); const arts=await frozenArticles(job);
    if(cs.length!==job.existing_article_count || arts.length!==job.existing_article_count || cs.length!==arts.length) {
      throw new Error(`REVIEW: consensus/frozen count mismatch consensus=${cs.length} frozen=${arts.length} expected=${job.existing_article_count}`);
    }
    const {data:auto,error:autoError}=await supabaseAdmin.rpc('resolve_inventory_mapping_auto_v2',{p_job_id:job.id});
    if(autoError) throw new Error(autoError.message);
    const unresolved=Number((auto as JsonRecord)?.unresolved ?? cs.length);
    if(unresolved===0) return Response.json({claimed:1,stage:'auto_map_finalize',job_id:job.id,auto,result:await finalize(job)},{headers:{'cache-control':'no-store'}});
    const mkinds=await mappingPassKinds(job.id);
    const user=JSON.stringify({candidates:cs.map(c=>({group_fingerprint:c.group_fingerprint,headline_anchor:c.headline_anchor,ocr_text:c.group_text.slice(0,18000)})),frozen_articles:arts.map(a=>({article_id:a.article_id,headline:a.headline,article_index:a.article_index,ocr_text:a.ocr_text.slice(0,18000)}))});
    if(!mkinds.has('mapper')) {
      const system='You are the mapper in an independent article identity mapping audit. Match every blind inventory group to exactly one frozen formal article, and every frozen article to exactly one group. Use only candidate OCR/headline evidence and frozen article headline/OCR. Do not infer from UUID shape, filenames, upload order, or prior mappings. Return a complete bijection with confidence at least 0.80.';
      const receipt=await callStructured(mappingMapperModel,system,user,mappingSchema); const mappings=parseMappings(receipt.parsed,cs,arts); await storeMapping(job,'mapper',mappingMapperModel,receipt,mappings);
      return Response.json({claimed:1,stage:'mapping_mapper',job_id:job.id,yield:await yieldJob(job,'mapping_mapper')},{headers:{'cache-control':'no-store'}});
    }
    if(!mkinds.has('critic')) {
      const system='You are the critic in an independent article identity mapping audit. Independently match every blind inventory group to exactly one frozen formal article, and every frozen article to exactly one group. Use only candidate OCR/headline evidence and frozen article headline/OCR. Do not use mapper output and do not infer from UUID shape, filenames, or upload order. Return a complete bijection with confidence at least 0.80.';
      const receipt=await callStructured(mappingCriticModel,system,user,mappingSchema); const mappings=parseMappings(receipt.parsed,cs,arts); await storeMapping(job,'critic',mappingCriticModel,receipt,mappings);
      return Response.json({claimed:1,stage:'mapping_critic',job_id:job.id,yield:await yieldJob(job,'mapping_critic')},{headers:{'cache-control':'no-store'}});
    }
    return Response.json({claimed:1,stage:'mapping_finalize',job_id:job.id,result:await finalize(job)},{headers:{'cache-control':'no-store'}});
  } catch (e) {
    const message=e instanceof Error?e.message:'unknown smoke error';
    const result=message.startsWith('REVIEW:')?await reviewJob(job,message):await failJob(job,message);
    return Response.json({claimed:1,stage:message.startsWith('REVIEW:')?'needs_review':'failed_or_requeued',job_id:job.id,error:message,result},{status:500,headers:{'cache-control':'no-store'}});
  }
}
