import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const BRANCH = 'agent/inventory-smoke-v2';
const JOB_ID = '8351828e-33e2-446e-9485-f4d6fa3b2dcd';
const NONCE_SHA256 = '981751cf963c3617691a7c9b4ec7465063c99d044598e0574e3cd88668410de0';

type R = Record<string, unknown>;
type Job = { id:string; page_identity_source_image_id:string; inventory_source_image_id:string; source_ocr_json_sha256:string; block_count:number; existing_article_count:number; lease_token:string };
type Block = { block_index:number; block_text:string; x_min:number; y_min:number; x_max:number; y_max:number; ocr_confidence:number; source_ocr_json_sha256:string };
type Group = { group_kind:'article'|'non_article'; block_indices:number[]; headline_anchor:string; non_article_role:string; confidence:number; reason:string };
type Candidate = { group_fingerprint:string; headline_anchor:string; block_indices:number[]; group_text:string };
type Article = { id:string; headline:string; ocr_text:string; source_image_id:string };
type Mapping = { group_fingerprint:string; article_id:string; confidence:number; rationale:string };

const blindSchema = { name:'blind_article_inventory', strict:true, schema:{ type:'object', additionalProperties:false, required:['groups'], properties:{ groups:{ type:'array', minItems:1, items:{ type:'object', additionalProperties:false, required:['group_kind','block_indices','headline_anchor','non_article_role','confidence','reason'], properties:{ group_kind:{type:'string',enum:['article','non_article']}, block_indices:{type:'array',minItems:1,items:{type:'integer',minimum:0}}, headline_anchor:{type:'string'}, non_article_role:{type:'string'}, confidence:{type:'number',minimum:0,maximum:1}, reason:{type:'string'} } } } } } } as const;
const mappingSchema = { name:'article_identity_mapping', strict:true, schema:{ type:'object', additionalProperties:false, required:['mappings'], properties:{ mappings:{ type:'array', minItems:1, items:{ type:'object', additionalProperties:false, required:['group_fingerprint','article_id','confidence','rationale'], properties:{ group_fingerprint:{type:'string'}, article_id:{type:'string'}, confidence:{type:'number',minimum:0,maximum:1}, rationale:{type:'string'} } } } } } } as const;

function auth(req:Request){
  if(process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256,'hex');
  return actual.length === expected.length && timingSafeEqual(actual,expected);
}
function sha(s:string){ return createHash('sha256').update(s).digest('hex'); }
function asObj(v:unknown):R{ if(!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('REVIEW: response object required'); return v as R; }
function outputText(p:R){
  if(typeof p.output_text === 'string' && p.output_text.trim()) return p.output_text;
  for(const item0 of Array.isArray(p.output) ? p.output : []){
    const item = item0 && typeof item0 === 'object' ? item0 as R : {};
    for(const part0 of Array.isArray(item.content) ? item.content : []){
      const part = part0 && typeof part0 === 'object' ? part0 as R : {};
      if(typeof part.text === 'string' && part.text.trim()) return part.text;
    }
  }
  throw new Error('OpenAI response missing output text');
}
async function callStructured(model:string, system:string, user:string, schema:typeof blindSchema|typeof mappingSchema){
  const key = getOpenAIKey();
  if(!key) throw new Error('OPENAI_API_KEY is not configured');
  const body = { model, store:false, max_output_tokens:12000, input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:user}]}], text:{format:{type:'json_schema',...schema}} };
  const promptSha256 = sha(JSON.stringify(body));
  const res = await fetch('https://api.openai.com/v1/responses',{ method:'POST', headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(150000) });
  const raw = await res.text();
  if(!res.ok) throw new Error(`OpenAI Responses API failed: ${res.status} ${raw.slice(0,500)}`);
  const payload = JSON.parse(raw) as R;
  const providerResponseId = String(payload.id || '');
  if(!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('OpenAI response id is not a real provider receipt');
  return { parsed:JSON.parse(outputText(payload)) as R, providerResponseId, promptSha256, responseSha256:sha(raw) };
}
async function claim(){
  const {data,error} = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_smoke_v1',{p_job_id:JOB_ID,p_lease_seconds:240});
  if(error) throw new Error(error.message);
  return ((Array.isArray(data)?data[0]:data)||null) as Job|null;
}
async function loadBlocks(j:Job){
  const {data,error} = await supabaseAdmin.from('source_ocr_blocks_v1').select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256').eq('source_image_id',j.inventory_source_image_id).eq('page_index',0).eq('source_ocr_json_sha256',j.source_ocr_json_sha256).order('block_index',{ascending:true});
  if(error) throw new Error(error.message);
  const blocks = (data||[]) as Block[];
  if(blocks.length !== j.block_count) throw new Error(`REVIEW: block count mismatch ${blocks.length}/${j.block_count}`);
  return blocks;
}
function parseGroups(parsed:R, blocks:Block[]):Group[]{
  if(!Array.isArray(parsed.groups) || !parsed.groups.length) throw new Error('REVIEW: groups array is missing');
  const valid = new Map(blocks.map(x=>[x.block_index,x.block_text]));
  const seen = new Set<number>();
  const groups = parsed.groups.map((raw,i)=>{
    const r = asObj(raw);
    const kind = String(r.group_kind||'');
    if(kind !== 'article' && kind !== 'non_article') throw new Error(`REVIEW: invalid group_kind ${i}`);
    if(!Array.isArray(r.block_indices) || !r.block_indices.length) throw new Error(`REVIEW: empty block_indices ${i}`);
    const ids = r.block_indices.map(Number);
    for(const id of ids){ if(!Number.isInteger(id)||!valid.has(id)) throw new Error(`REVIEW: unknown block index ${id}`); if(seen.has(id)) throw new Error(`REVIEW: block ${id} assigned more than once`); seen.add(id); }
    const headline = String(r.headline_anchor||'').trim();
    const role = String(r.non_article_role||'').trim();
    const confidence = Number(r.confidence);
    if(!Number.isFinite(confidence)||confidence<0.8) throw new Error(`REVIEW: low confidence group ${confidence}`);
    if(kind === 'article'){
      if(!headline) throw new Error('REVIEW: headline_anchor missing');
      const normalized = headline.replace(/\s+/g,'').toLowerCase();
      if(!ids.some(id=>(valid.get(id)||'').replace(/\s+/g,'').toLowerCase().includes(normalized))) throw new Error('REVIEW: headline_anchor not in group OCR');
    } else if(!role) throw new Error('REVIEW: non_article_role missing');
    return { group_kind:kind, block_indices:ids, headline_anchor:kind==='article'?headline:'', non_article_role:kind==='non_article'?role:'', confidence, reason:String(r.reason||'') } as Group;
  });
  if(seen.size !== blocks.length) throw new Error(`REVIEW: block partition incomplete ${seen.size}/${blocks.length}`);
  return groups;
}
async function blindKinds(id:string){ const {data,error}=await supabaseAdmin.from('source_page_article_inventory_pass_runs_v1').select('pass_kind').eq('job_id',id); if(error) throw new Error(error.message); return new Set((data||[]).map(x=>String(x.pass_kind))); }
async function storeBlind(j:Job, kind:'mapper'|'critic', model:string, receipt:Awaited<ReturnType<typeof callStructured>>, groups:Group[]){
  const {error}=await supabaseAdmin.rpc('replace_source_page_article_inventory_pass_v1',{p_job_id:j.id,p_lease_token:j.lease_token,p_pass_kind:kind,p_model:model,p_provider_response_id:receipt.providerResponseId,p_prompt_sha256:receipt.promptSha256,p_response_sha256:receipt.responseSha256,p_groups:groups});
  if(error) throw new Error(error.message);
}
async function loadCandidates(jobId:string){
  const {data,error}=await supabaseAdmin.from('source_page_article_inventory_consensus_groups_v2').select('group_fingerprint,headline_anchor,block_indices,group_text').eq('job_id',jobId);
  if(error) throw new Error(error.message);
  return (data||[]) as Candidate[];
}
async function loadArticles(j:Job){
  const {data:maps,error:me}=await supabaseAdmin.from('source_page_capture_map_v1').select('source_image_id').eq('page_identity_source_image_id',j.page_identity_source_image_id);
  if(me) throw new Error(me.message);
  const ids=[...new Set((maps||[]).map(x=>String(x.source_image_id)).filter(Boolean))];
  if(!ids.length) throw new Error('REVIEW: page capture map is empty');
  const {data,error}=await supabaseAdmin.from('formal_corpus_articles_v1').select('id,headline,ocr_text,source_image_id').in('source_image_id',ids).order('article_index',{ascending:true});
  if(error) throw new Error(error.message);
  const articles=(data||[]) as Article[];
  if(articles.length !== j.existing_article_count) throw new Error(`REVIEW: frozen article count mismatch ${articles.length}/${j.existing_article_count}`);
  return articles;
}
function parseMappings(parsed:R,candidates:Candidate[],articles:Article[]):Mapping[]{
  if(!Array.isArray(parsed.mappings)) throw new Error('REVIEW: mappings array missing');
  const cset=new Set(candidates.map(x=>x.group_fingerprint)); const aset=new Set(articles.map(x=>x.id)); const cs=new Set<string>(); const as=new Set<string>();
  const rows=parsed.mappings.map((raw,i)=>{ const r=asObj(raw); const g=String(r.group_fingerprint||''); const a=String(r.article_id||''); const c=Number(r.confidence); const rationale=String(r.rationale||'').trim(); if(!cset.has(g)||!aset.has(a)) throw new Error(`REVIEW: unknown mapping identity ${i}`); if(cs.has(g)||as.has(a)) throw new Error('REVIEW: mapping is not bijective'); if(!Number.isFinite(c)||c<0.8) throw new Error(`REVIEW: low mapping confidence ${c}`); cs.add(g); as.add(a); return {group_fingerprint:g,article_id:a,confidence:c,rationale}; });
  if(rows.length!==candidates.length||rows.length!==articles.length) throw new Error(`REVIEW: mapping row count mismatch ${rows.length}/${candidates.length}/${articles.length}`);
  return rows;
}
async function mappingKinds(id:string){ const {data,error}=await supabaseAdmin.from('source_page_article_inventory_mapping_pass_runs_v2').select('pass_kind').eq('job_id',id); if(error) throw new Error(error.message); return new Set((data||[]).map(x=>String(x.pass_kind))); }
async function storeMapping(j:Job,kind:'mapper'|'critic',model:string,receipt:Awaited<ReturnType<typeof callStructured>>,mappings:Mapping[]){ const {error}=await supabaseAdmin.rpc('replace_inventory_mapping_pass_v2',{p_job_id:j.id,p_lease_token:j.lease_token,p_pass_kind:kind,p_model:model,p_provider_response_id:receipt.providerResponseId,p_prompt_sha256:receipt.promptSha256,p_response_sha256:receipt.responseSha256,p_mappings:mappings}); if(error) throw new Error(error.message); }
async function yieldJob(j:Job,stage:string){ const {data,error}=await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2',{p_job_id:j.id,p_lease_token:j.lease_token,p_stage:stage}); if(error) throw new Error(error.message); return data; }
async function review(j:Job,message:string){ const {data,error}=await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1',{p_job_id:j.id,p_lease_token:j.lease_token,p_reason:message.slice(0,3900)}); if(error) throw new Error(error.message); return data; }
async function fail(j:Job,message:string){ const {data,error}=await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2',{p_job_id:j.id,p_lease_token:j.lease_token,p_error_message:message.slice(0,3900),p_retryable:true}); if(error) throw new Error(error.message); return data; }

export async function GET(req:Request){
  if(!auth(req)) return new Response('Not Found',{status:404});
  const j=await claim();
  if(!j){ const {data}=await supabaseAdmin.from('source_page_article_inventory_jobs_v1').select('id,status,attempt_count,error_message,finished_at').eq('id',JOB_ID).single(); return Response.json({claimed:0,job:data},{headers:{'cache-control':'no-store'}}); }
  try{
    const blindMapper=process.env.OPENAI_INVENTORY_MAPPER_MODEL||'gpt-4.1';
    const blindCritic=process.env.OPENAI_INVENTORY_CRITIC_MODEL||'gpt-4o';
    const mapMapper=process.env.OPENAI_INVENTORY_MAPPING_MAPPER_MODEL||'gpt-4.1';
    const mapCritic=process.env.OPENAI_INVENTORY_MAPPING_CRITIC_MODEL||'gpt-4o';
    if(blindMapper===blindCritic||mapMapper===mapCritic) throw new Error('REVIEW: independent models identical');
    const blocks=await loadBlocks(j);
    const kinds=await blindKinds(j.id);
    const blindBase='Use only the supplied OCR blocks. Partition every OCR block exactly once into distinct editorial article groups or non_article groups. Internal subheads, author bios, captions and continuation columns belong to the same editorial article when content and layout continue it; do not split merely because of an internal subheading. Ignore any existing article list, filename, upload metadata or prior model output. For article groups, headline_anchor must be a verbatim substring from one of that group’s OCR blocks and non_article_role must be an empty string. For non_article groups, headline_anchor must be an empty string and non_article_role must be specific. Confidence below 0.80 is not acceptable.';
    if(!kinds.has('mapper')){ const r=await callStructured(blindMapper,'You are the mapper in an independent blind page-level article inventory audit. '+blindBase,JSON.stringify({job:{block_count:j.block_count,source_ocr_json_sha256:j.source_ocr_json_sha256},blocks}),blindSchema); await storeBlind(j,'mapper',blindMapper,r,parseGroups(r.parsed,blocks)); return Response.json({claimed:1,stage:'blind_mapper',job_id:j.id,yield:await yieldJob(j,'blind_mapper')},{headers:{'cache-control':'no-store'}}); }
    if(!kinds.has('critic')){ const r=await callStructured(blindCritic,'You are the critic in an independent blind page-level article inventory audit. Do not assume the mapper result. '+blindBase,JSON.stringify({job:{block_count:j.block_count,source_ocr_json_sha256:j.source_ocr_json_sha256},blocks}),blindSchema); await storeBlind(j,'critic',blindCritic,r,parseGroups(r.parsed,blocks)); return Response.json({claimed:1,stage:'blind_critic',job_id:j.id,yield:await yieldJob(j,'blind_critic')},{headers:{'cache-control':'no-store'}}); }
    const candidates=await loadCandidates(j.id);
    if(candidates.length!==j.existing_article_count) throw new Error(`REVIEW: blind disagreement consensus=${candidates.length} expected=${j.existing_article_count}`);
    const {data:auto,error:autoError}=await supabaseAdmin.rpc('resolve_inventory_mapping_auto_v2',{p_job_id:j.id}); if(autoError) throw new Error(autoError.message);
    const unresolved=Number((auto as R)?.unresolved??j.existing_article_count);
    if(unresolved>0){
      const articles=await loadArticles(j); const mk=await mappingKinds(j.id);
      const payload={candidates:candidates.map(c=>({group_fingerprint:c.group_fingerprint,headline_anchor:c.headline_anchor,ocr_text:c.group_text})),articles:articles.map(a=>({article_id:a.id,headline:a.headline,ocr_text:(a.ocr_text||'').slice(0,18000)}))};
      const mapBase='Match every blind inventory candidate to exactly one frozen article and every frozen article to exactly one candidate. Use only headline and OCR-text evidence in the supplied payload. Do not infer from UUID shape, ordering, filenames, upload metadata or prior mapping output. Return a complete bijection. Confidence below 0.80 is not acceptable.';
      if(!mk.has('mapper')){ const r=await callStructured(mapMapper,'You are the mapper for independent article identity mapping. '+mapBase,JSON.stringify(payload),mappingSchema); await storeMapping(j,'mapper',mapMapper,r,parseMappings(r.parsed,candidates,articles)); return Response.json({claimed:1,stage:'mapping_mapper',job_id:j.id,auto,yield:await yieldJob(j,'mapping_mapper')},{headers:{'cache-control':'no-store'}}); }
      if(!mk.has('critic')){ const r=await callStructured(mapCritic,'You are the critic for independent article identity mapping. Do not assume the mapper result. '+mapBase,JSON.stringify(payload),mappingSchema); await storeMapping(j,'critic',mapCritic,r,parseMappings(r.parsed,candidates,articles)); return Response.json({claimed:1,stage:'mapping_critic',job_id:j.id,auto,yield:await yieldJob(j,'mapping_critic')},{headers:{'cache-control':'no-store'}}); }
    }
    const {data:result,error}=await supabaseAdmin.rpc('finalize_source_page_article_inventory_job_v1',{p_job_id:j.id,p_lease_token:j.lease_token}); if(error) throw new Error(`REVIEW: ${error.message}`);
    return Response.json({claimed:1,stage:'finalize',job_id:j.id,auto,result},{headers:{'cache-control':'no-store'}});
  }catch(e){
    const message=e instanceof Error?e.message:'unknown';
    const result=message.startsWith('REVIEW:')?await review(j,message):await fail(j,message);
    return Response.json({claimed:1,stage:message.startsWith('REVIEW:')?'needs_review':'failed_or_requeued',job_id:j.id,error:message,result},{status:500,headers:{'cache-control':'no-store'}});
  }
}
