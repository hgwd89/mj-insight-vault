import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from './supabaseAdmin';
import { getOpenAIKey } from './openai';
import { runArticleInventoryWorkerV6GroundedStep } from './articleInventoryWorkerV6Grounded';

type JsonRecord = Record<string, unknown>;
type PassKind = 'mapper' | 'critic' | 'adjudicator';
type ClaimedJob = {
  id: string;
  inventory_source_image_id: string;
  source_ocr_json_sha256: string;
  block_count: number;
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
  source_ocr_json_sha256: string;
};
type Rect = { x_min: number; y_min: number; x_max: number; y_max: number };
type VisualArticle = { headline_hint: string; confidence: number; regions: Rect[]; reason: string };
type SourceImage = { buffer: Buffer; mimeType: string; width: number; height: number };
type GroundedEvidence = {
  article: VisualArticle;
  groundedBlockIndices: number[];
  ambiguousBlockCount: number;
  droppedFromPartition: boolean;
};

class ReviewRequiredError extends Error {}
const COORD_MAX = 1000;
const CENTER_MARGIN = 6;
const MIN_RAW_CONFIDENCE = 0.60;

const visualSchema = {
  type: 'json_schema',
  name: 'mj_grounded_visual_article_regions_v7_adjudicator',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false, required: ['articles'],
    properties: {
      articles: {
        type: 'array', minItems: 1, maxItems: 12,
        items: {
          type: 'object', additionalProperties: false,
          required: ['headline_hint', 'confidence', 'regions', 'reason'],
          properties: {
            headline_hint: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
            regions: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false,
                required: ['x_min', 'y_min', 'x_max', 'y_max'],
                properties: {
                  x_min: { type: 'integer', minimum: 0, maximum: 1000 },
                  y_min: { type: 'integer', minimum: 0, maximum: 1000 },
                  x_max: { type: 'integer', minimum: 0, maximum: 1000 },
                  y_max: { type: 'integer', minimum: 0, maximum: 1000 }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function text(value: unknown) { return value == null ? '' : String(value).trim(); }
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewRequiredError('Expected object response.');
  return value as JsonRecord;
}
function outputText(payload: JsonRecord) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  for (const rawItem of Array.isArray(payload.output) ? payload.output : []) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as JsonRecord : {};
    for (const rawPart of Array.isArray(item.content) ? item.content : []) {
      const part = rawPart && typeof rawPart === 'object' ? rawPart as JsonRecord : {};
      if (typeof part.text === 'string' && part.text.trim()) return part.text.trim();
    }
  }
  throw new ReviewRequiredError('OpenAI response missing output text.');
}
function normalizeText(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function bigrams(value: string) {
  const n = normalizeText(value); const out = new Set<string>();
  if (n.length === 1) out.add(n);
  for (let i = 0; i < n.length - 1; i += 1) out.add(n.slice(i, i + 2));
  return out;
}
function textSimilarity(a: string, b: string) {
  const aa = bigrams(a), bb = bigrams(b); if (!aa.size || !bb.size) return 0;
  let hit = 0; for (const x of aa) if (bb.has(x)) hit += 1;
  return 2 * hit / (aa.size + bb.size);
}

async function claim(jobId?: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_v3', {
    p_job_id: jobId || null, p_lease_seconds: 420
  });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as ClaimedJob | null;
}
async function yieldJob(job: ClaimedJob, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_stage: stage
  });
  if (error) throw new Error(error.message); return data;
}
async function reviewJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason.slice(0, 3000)
  });
  if (error) throw new Error(`${reason}; review rpc: ${error.message}`); return data;
}
async function failJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_error_message: reason.slice(0, 3000), p_retryable: true
  });
  if (error) throw new Error(`${reason}; fail rpc: ${error.message}`); return data;
}
async function passRows(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_pass_runs_v1')
    .select('pass_kind,model').eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({ pass_kind: String(r.pass_kind) as PassKind, model: String(r.model) }));
}
async function loadBlocks(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,source_ocr_json_sha256')
    .eq('job_id', job.id).order('block_index');
  if (error) throw new Error(error.message);
  const blocks = (data || []) as Block[];
  if (blocks.length !== job.block_count || blocks.some((b) => b.source_ocr_json_sha256 !== job.source_ocr_json_sha256)) {
    throw new ReviewRequiredError('Fresh OCR block provenance drift.');
  }
  return blocks;
}
async function loadSource(job: ClaimedJob): Promise<SourceImage> {
  const { data, error } = await supabaseAdmin.from('source_images')
    .select('storage_path,mime_type,width,height,storage_size_bytes').eq('id', job.inventory_source_image_id).single();
  if (error) throw new Error(error.message);
  const width = Number(data.width || 0), height = Number(data.height || 0), expected = Number(data.storage_size_bytes || 0);
  if (!data.storage_path || width < 1 || height < 1) throw new ReviewRequiredError('Source image metadata incomplete.');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(String(data.storage_path));
  if (downloaded.error || !downloaded.data) throw new Error(downloaded.error?.message || 'Image download failed.');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (expected > 0 && buffer.length !== expected) throw new ReviewRequiredError('Source image size drift.');
  return { buffer, width, height, mimeType: String(data.mime_type || downloaded.data.type || 'image/jpeg') };
}

function instructions() {
  return [
    'You are the independent adjudicator for newspaper page layout.',
    'Use only the supplied page image. Do not use database article counts, filenames, prior OCR grouping, or prior pass outputs.',
    'Identify every distinct standalone editorial article visible on the page.',
    'Do not count advertisements, advertorial-looking promotional panels, mastheads, folios, navigation, subscription notices, decorative text, isolated captions, or charts without a standalone editorial article.',
    'A subsection or subheading inside one article is not a separate article.',
    'If one article occupies several separated columns or non-rectangular areas, return multiple tight rectangles for the same article.',
    'Each rectangle uses normalized page coordinates from 0 to 1000.',
    'Rectangles must be tight and must avoid neighboring articles and advertisements.',
    'headline_hint is a short visual transcription of the article headline.',
    'This raw adjudicator evidence may use confidence down to 0.60. Do not inflate confidence; final consensus applies a stricter threshold.',
    'Return only JSON matching the schema.'
  ].join(' ');
}
async function callVision(model: string, source: SourceImage) {
  const apiKey = getOpenAIKey(); if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const body = {
    model, store: false, max_output_tokens: 6000,
    instructions: instructions(),
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Audit this newspaper page visually and return all standalone editorial article regions. Use a 1000 x 1000 normalized coordinate system.' },
      { type: 'input_image', image_url: `data:${source.mimeType};base64,${source.buffer.toString('base64')}`, detail: 'high' }
    ] }],
    text: { format: visualSchema }
  };
  const promptSha256 = sha256(JSON.stringify(body));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(150000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const payload = JSON.parse(raw) as JsonRecord;
  const providerResponseId = text(payload.id);
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('Invalid provider response receipt.');
  let parsed: JsonRecord;
  try { parsed = JSON.parse(outputText(payload)) as JsonRecord; }
  catch { throw new ReviewRequiredError('Grounded adjudicator response is not valid JSON.'); }
  return { parsed, providerResponseId, promptSha256, responseSha256: sha256(raw) };
}
function parseArticles(parsed: JsonRecord): VisualArticle[] {
  if (!Array.isArray(parsed.articles) || parsed.articles.length < 1 || parsed.articles.length > 12) throw new ReviewRequiredError('Grounded adjudicator article count invalid.');
  return parsed.articles.map((raw, i) => {
    const item = record(raw); const hint = text(item.headline_hint); const confidence = Number(item.confidence); const reason = text(item.reason);
    if (hint.length < 2 || !Number.isFinite(confidence) || confidence < MIN_RAW_CONFIDENCE || confidence > 1 || reason.length < 2) {
      throw new ReviewRequiredError(`Grounded adjudicator article ${i} invalid hint/confidence/reason.`);
    }
    if (!Array.isArray(item.regions) || item.regions.length < 1 || item.regions.length > 8) throw new ReviewRequiredError(`Grounded adjudicator article ${i} regions invalid.`);
    const regions = item.regions.map((rr, j) => {
      const r = record(rr); const v = { x_min: Number(r.x_min), y_min: Number(r.y_min), x_max: Number(r.x_max), y_max: Number(r.y_max) };
      if (!Object.values(v).every(Number.isInteger) || v.x_min < 0 || v.y_min < 0 || v.x_max > 1000 || v.y_max > 1000 || v.x_max <= v.x_min || v.y_max <= v.y_min) {
        throw new ReviewRequiredError(`Grounded adjudicator article ${i} region ${j} invalid.`);
      }
      return v;
    });
    return { headline_hint: hint, confidence, regions, reason };
  });
}
function blockRect(block: Block, source: SourceImage): Rect {
  return { x_min: block.x_min/source.width*COORD_MAX, y_min: block.y_min/source.height*COORD_MAX, x_max: block.x_max/source.width*COORD_MAX, y_max: block.y_max/source.height*COORD_MAX };
}
function area(r: Rect) { return Math.max(1e-6,(r.x_max-r.x_min)*(r.y_max-r.y_min)); }
function intersect(a: Rect,b: Rect) { return Math.max(0,Math.min(a.x_max,b.x_max)-Math.max(a.x_min,b.x_min))*Math.max(0,Math.min(a.y_max,b.y_max)-Math.max(a.y_min,b.y_min)); }
function articleScore(block: Rect, article: VisualArticle) {
  const cx=(block.x_min+block.x_max)/2, cy=(block.y_min+block.y_max)/2; let best=0;
  for (const r of article.regions) {
    const coverage=intersect(block,r)/area(block);
    const inside=cx>=Math.max(0,r.x_min-CENTER_MARGIN)&&cx<=Math.min(1000,r.x_max+CENTER_MARGIN)&&cy>=Math.max(0,r.y_min-CENTER_MARGIN)&&cy<=Math.min(1000,r.y_max+CENTER_MARGIN);
    best=Math.max(best,inside?1+coverage:coverage>=0.35?coverage:0);
  }
  return best;
}
function chooseAnchor(article: VisualArticle, blocks: Block[]) {
  const maxHeight=Math.max(...blocks.map((b)=>Math.max(1,b.y_max-b.y_min))); let best:Block|null=null; let score=-1;
  for (const b of blocks) {
    if (b.block_text.trim().length<2) continue;
    const h=Math.min(1,Math.max(1,b.y_max-b.y_min)/maxHeight);
    const s=0.84*textSimilarity(article.headline_hint,b.block_text)+0.16*h;
    if (s>score) { score=s; best=b; }
  }
  if (!best) throw new ReviewRequiredError('Grounded adjudicator article has no anchor block.');
  const raw=best.block_text.trim(); return raw.length<=100?raw:raw.slice(0,100).trim();
}
function deriveGrounded(articles: VisualArticle[], blocks: Block[], source: SourceImage) {
  const assigned=new Map<number,number[]>(); const ambiguousByArticle=new Map<number,number>(); const leftovers:number[]=[];
  for (const b of blocks) {
    const scores=articles.map((a,i)=>({i,score:articleScore(blockRect(b,source),a)})).filter((x)=>x.score>0).sort((a,b2)=>b2.score-a.score||a.i-b2.i);
    if (!scores.length) { leftovers.push(b.block_index); continue; }
    if (scores.length>1 && scores[0].score-scores[1].score<0.08) {
      ambiguousByArticle.set(scores[0].i,(ambiguousByArticle.get(scores[0].i)||0)+1);
      ambiguousByArticle.set(scores[1].i,(ambiguousByArticle.get(scores[1].i)||0)+1);
    }
    const list=assigned.get(scores[0].i)||[]; list.push(b.block_index); assigned.set(scores[0].i,list);
  }
  const byIndex=new Map(blocks.map((b)=>[b.block_index,b])); const groups:JsonRecord[]=[]; const evidence:GroundedEvidence[]=[];
  articles.forEach((a,i)=>{
    const ids=(assigned.get(i)||[]).sort((x,y)=>x-y); const dropped=ids.length===0;
    evidence.push({article:a,groundedBlockIndices:ids,ambiguousBlockCount:ambiguousByArticle.get(i)||0,droppedFromPartition:dropped});
    if (dropped) return;
    const articleBlocks=ids.map((id)=>byIndex.get(id)).filter(Boolean) as Block[];
    groups.push({group_kind:'article',block_indices:ids,headline_anchor:chooseAnchor(a,articleBlocks),non_article_role:'',confidence:a.confidence,reason:`grounded_visual_v7 pass=adjudicator; hint=${a.headline_hint}; regions=${JSON.stringify(a.regions)}; ambiguous=${ambiguousByArticle.get(i)||0}; ${a.reason}`});
  });
  if (leftovers.length) groups.push({group_kind:'non_article',block_indices:leftovers.sort((a,b)=>a-b),headline_anchor:'',non_article_role:'outside_all_grounded_adjudicator_regions',confidence:0.99,reason:'deterministic complement of grounded adjudicator regions'});
  if (!groups.length) throw new ReviewRequiredError('Grounded adjudicator produced no block-grounded partition.');
  return { groups, evidence };
}
async function persistEvidence(job: ClaimedJob, model: string, receipt: {providerResponseId:string;promptSha256:string;responseSha256:string}, evidence: GroundedEvidence[]) {
  const rows=evidence.map((e,i)=>({
    job_id:job.id,pass_kind:'adjudicator',article_seq:i+1,headline_hint:e.article.headline_hint,confidence:e.article.confidence,
    regions:e.article.regions,reason:e.article.reason,grounded_block_count:e.groundedBlockIndices.length,
    ambiguous_block_count:e.ambiguousBlockCount,dropped_from_partition:e.droppedFromPartition,model,
    provider_response_id:receipt.providerResponseId,prompt_sha256:receipt.promptSha256,response_sha256:receipt.responseSha256
  }));
  const { error }=await supabaseAdmin.from('source_page_inventory_visual_region_evidence_v6').upsert(rows,{onConflict:'job_id,pass_kind,article_seq'});
  if (error) throw new Error(error.message);
}
async function runGroundedAdjudicator(job: ClaimedJob, existingModels: string[]) {
  const model=process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL||'gpt-4o-mini';
  if (existingModels.includes(model)) throw new ReviewRequiredError('Grounded adjudicator must use a model distinct from mapper and critic.');
  const [blocks,source]=await Promise.all([loadBlocks(job),loadSource(job)]);
  const receipt=await callVision(model,source); const articles=parseArticles(receipt.parsed); const grounded=deriveGrounded(articles,blocks,source);
  const { data,error }=await supabaseAdmin.rpc('record_source_page_article_inventory_pass_v3',{
    p_job_id:job.id,p_lease_token:job.lease_token,p_pass_kind:'adjudicator',p_model:model,p_provider_response_id:receipt.providerResponseId,
    p_prompt_sha256:receipt.promptSha256,p_response_sha256:receipt.responseSha256,p_groups:grounded.groups
  });
  if (error) throw new Error(error.message);
  await persistEvidence(job,model,receipt,grounded.evidence);
  return {stored:data,article_regions:articles.length,grounded_articles:grounded.evidence.filter((e)=>!e.droppedFromPartition).length,zero_block_regions:grounded.evidence.filter((e)=>e.droppedFromPartition).length};
}

export async function runArticleInventoryWorkerV7GroundedOrchestratorStep(jobId?: string) {
  const job=await claim(jobId);
  if (!job) return {claimed:0,job_id:jobId||null,worker_version:'article_inventory_v7_grounded_orchestrator'};
  try {
    const rows=await passRows(job.id); const kinds=new Set(rows.map((r)=>r.pass_kind));
    if (!kinds.has('mapper') || !kinds.has('critic')) {
      const released=await yieldJob(job,'delegate_grounded_v6_raw_pass');
      return {claimed:1,job_id:job.id,stage:'delegate_grounded_v6_raw_pass',released,delegated:await runArticleInventoryWorkerV6GroundedStep(job.id)};
    }
    if (job.requires_third_pass && !kinds.has('adjudicator')) {
      const result=await runGroundedAdjudicator(job,rows.map((r)=>r.model));
      return {claimed:1,job_id:job.id,stage:'grounded_adjudicator_v7',result,yield:await yieldJob(job,'grounded_adjudicator_v7')};
    }
    const released=await yieldJob(job,'delegate_grounded_v6_consensus');
    return {claimed:1,job_id:job.id,stage:'delegate_grounded_v6_consensus',released,delegated:await runArticleInventoryWorkerV6GroundedStep(job.id)};
  } catch (error) {
    const message=error instanceof Error?error.message:'grounded v7 orchestrator error';
    if (error instanceof ReviewRequiredError) return {claimed:1,job_id:job.id,stage:'grounded_v7_review',error:message,result:await reviewJob(job,message)};
    return {claimed:1,job_id:job.id,stage:'grounded_v7_failed',error:message,result:await failJob(job,message)};
  }
}
