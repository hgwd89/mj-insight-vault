import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;
type PassKind = 'reviewer' | 'critic';
class StructuralOutputError extends Error {}
class ProviderError extends Error { retryable: boolean; constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; } }

const CALL_TIMEOUT_MS = 150_000;
const SUBJECTS = ['consumer','company','market','expert','regulator','worker','mixed','unclear'] as const;
const MEASUREMENTS = ['survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other'] as const;

const REVIEWER_FORMAT = {
  type: 'json_schema', name: 'mj_verified_article_reviewer', strict: true,
  schema: { type: 'object', additionalProperties: false,
    required: ['subject','measurement','consumer_relevance','observed_fact','limitation','no_theme_signal','no_theme_signal_reason','observed_fact_anchor','coverage_anchors','theme_seeds'],
    properties: {
      subject: { type: 'string', enum: SUBJECTS }, measurement: { type: 'string', enum: MEASUREMENTS },
      consumer_relevance: { type: 'string' }, observed_fact: { type: 'string' }, limitation: { type: 'string' },
      no_theme_signal: { type: 'boolean' }, no_theme_signal_reason: { type: 'string' }, observed_fact_anchor: { type: 'string' },
      coverage_anchors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['anchor_text'], properties: { anchor_text: { type: 'string' } } } },
      theme_seeds: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['seed_label','seed_statement','subject','measurement','confidence','source_anchor'],
        properties: { seed_label:{type:'string'}, seed_statement:{type:'string'}, subject:{type:'string',enum:SUBJECTS}, measurement:{type:'string',enum:MEASUREMENTS}, confidence:{type:'number',minimum:0,maximum:1}, source_anchor:{type:'string'} }
      } }
    }
  }
} as const;

const CRITIC_FORMAT = {
  type: 'json_schema', name: 'mj_verified_article_review_critic', strict: true,
  schema: { type:'object', additionalProperties:false,
    required:['verdict','fact_supported','coverage_complete','no_theme_signal_valid','seeds_grounded','overclaim_risk','reason'],
    properties:{ verdict:{type:'string',enum:['approved','rejected','unresolved']}, fact_supported:{type:'boolean'}, coverage_complete:{type:'boolean'}, no_theme_signal_valid:{type:'boolean'}, seeds_grounded:{type:'boolean'}, overclaim_risk:{type:'boolean'}, reason:{type:'string'} }
  }
} as const;

function isRecord(v: unknown): v is JsonRecord { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }
function text(v: unknown) { return v == null ? '' : String(v).trim(); }
function sha256(v: string | Buffer) { return createHash('sha256').update(v).digest('hex'); }
function errMsg(e: unknown) { return e instanceof Error ? e.message : isRecord(e) ? text(e.message || e.error || e.details) : text(e) || 'article review worker failed'; }
function responseText(j: unknown) { const x=j as {output_text?:string;output?:Array<{content?:Array<{text?:string}>}>}; if(x?.output_text?.trim())return x.output_text.trim(); return (x?.output||[]).flatMap(i=>i.content||[]).map(c=>text(c.text)).filter(Boolean).join('\n').trim(); }
function models(){ const reviewer=process.env.OPENAI_ARTICLE_REVIEW_REVIEWER_MODEL?.trim()||TEXT_MODEL; const critic=process.env.OPENAI_ARTICLE_REVIEW_CRITIC_MODEL?.trim()||(reviewer==='gpt-4o'?'gpt-4.1':'gpt-4o'); if(!reviewer||!critic||reviewer===critic) throw new StructuralOutputError('Article review reviewer and critic models must be configured and distinct.'); return {reviewer,critic}; }
function anchorInText(body:string, anchor:string){ return anchor.length>=6 && body.toLocaleLowerCase().includes(anchor.toLocaleLowerCase()); }

async function callJson(model:string,instructions:string,userText:string,format:unknown){
  const key=getOpenAIKey(); if(!key) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');
  const promptSha=sha256([model,instructions,userText].join('\n---\n')); const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),CALL_TIMEOUT_MS);
  try{ const res=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},signal:ctl.signal,body:JSON.stringify({model,store:false,max_output_tokens:5000,instructions,input:[{role:'user',content:[{type:'input_text',text:userText}]}],text:{format}})}); const raw=await res.text(); if(!res.ok) throw new ProviderError(`OpenAI Responses API failed: ${res.status} ${res.statusText} ${raw.slice(0,1800)}`,res.status===408||res.status===409||res.status===429||res.status>=500); const json=JSON.parse(raw) as JsonRecord; const id=text(json.id); const out=responseText(json); if(!id||!out) throw new ProviderError('OpenAI article review receipt or output is missing.',true); let value:unknown; try{value=JSON.parse(out);}catch{throw new StructuralOutputError('Article review JSON output is invalid.');} return {value,providerResponseId:id,promptSha,responseSha:sha256(raw)}; }
  catch(e){ if(e instanceof ProviderError||e instanceof StructuralOutputError) throw e; if(e instanceof Error && e.name==='AbortError') throw new ProviderError('OpenAI article review request timed out.',true); throw e; } finally{clearTimeout(timer);}
}

function validateReviewer(v:unknown, body:string){ if(!isRecord(v)) throw new StructuralOutputError('reviewer result is not an object'); const noTheme=v.no_theme_signal===true; const fact=text(v.observed_fact), factAnchor=text(v.observed_fact_anchor), limitation=text(v.limitation), relevance=text(v.consumer_relevance), reason=text(v.no_theme_signal_reason); if(!SUBJECTS.includes(text(v.subject) as never)||!MEASUREMENTS.includes(text(v.measurement) as never)) throw new StructuralOutputError('reviewer subject or measurement invalid'); if(fact.length<8||!anchorInText(body,factAnchor)||limitation.length<4||relevance.length<2) throw new StructuralOutputError('reviewer fact/anchor/limitation/relevance invalid'); if(noTheme&&reason.length<8) throw new StructuralOutputError('no-theme reason missing'); if(!Array.isArray(v.coverage_anchors)||!Array.isArray(v.theme_seeds)) throw new StructuralOutputError('reviewer arrays missing'); const expected=body.length<400?1:body.length<1200?2:3; if(v.coverage_anchors.length!==expected) throw new StructuralOutputError('coverage anchor count invalid'); const positions=v.coverage_anchors.map((a)=>{if(!isRecord(a))throw new StructuralOutputError('coverage anchor invalid');const s=text(a.anchor_text);const p=body.toLocaleLowerCase().indexOf(s.toLocaleLowerCase());if(s.length<6||p<0)throw new StructuralOutputError('coverage anchor not grounded');return p+1;}); if(new Set(v.coverage_anchors.map(a=>text((a as JsonRecord).anchor_text))).size!==expected) throw new StructuralOutputError('coverage anchors duplicated'); if(expected===2 && !(positions.some(p=>p<=body.length/2)&&positions.some(p=>p>body.length/2))) throw new StructuralOutputError('coverage halves incomplete'); if(expected===3 && !(positions.some(p=>p<=body.length/3)&&positions.some(p=>p>body.length/3&&p<=2*body.length/3)&&positions.some(p=>p>2*body.length/3))) throw new StructuralOutputError('coverage thirds incomplete'); if(noTheme&&v.theme_seeds.length!==0)throw new StructuralOutputError('no-theme article must have zero seeds'); if(!noTheme&&v.theme_seeds.length<1)throw new StructuralOutputError('theme signal requires seed'); for(const raw of v.theme_seeds){if(!isRecord(raw))throw new StructuralOutputError('theme seed invalid'); if(text(raw.seed_label).length<2||text(raw.seed_statement).length<8||!SUBJECTS.includes(text(raw.subject) as never)||!MEASUREMENTS.includes(text(raw.measurement) as never)||!Number.isFinite(Number(raw.confidence))||Number(raw.confidence)<0||Number(raw.confidence)>1||!anchorInText(body,text(raw.source_anchor)))throw new StructuralOutputError('theme seed invalid');}
  return v;
}
function validateCritic(v:unknown){ if(!isRecord(v)||!['approved','rejected','unresolved'].includes(text(v.verdict))||typeof v.fact_supported!=='boolean'||typeof v.coverage_complete!=='boolean'||typeof v.no_theme_signal_valid!=='boolean'||typeof v.seeds_grounded!=='boolean'||typeof v.overclaim_risk!=='boolean'||text(v.reason).length<4) throw new StructuralOutputError('critic result invalid'); return v; }
function instructions(pass:PassKind){ return pass==='reviewer' ? [
  'You are the first independent full-article reviewer for a verified newspaper corpus.','Use only verified_crop_ocr_text. Do not use the category profile, headline, embeddings, outside knowledge, or unstated context.','Extract one central observed fact and its exact contiguous source anchor.','Coverage anchors must be exact contiguous substrings and collectively span the article: one for short text, both halves for medium text, all thirds for long text.','Create grounded theme seeds only when the text contains a defensible recurring-market or consumer signal. A seed is evidence, not a final theme.','If there is no defensible theme signal, set no_theme_signal=true and return zero seeds.','Do not overclaim causality or prevalence. State limitations explicitly.','Return only JSON.'
].join('\n') : [
  'You are an independent critic of a full-article review.','You receive the same verified crop OCR text plus the first reviewer output.','Verify every factual claim, anchor, coverage claim, no-theme decision, and theme seed against the supplied text.','Approve only if the observed fact is supported, coverage is complete, the no-theme decision is valid, all seeds are grounded, and there is no material overclaim.','Do not repair the reviewer output. Reject or mark unresolved instead.','Return only JSON.'
].join('\n'); }

async function enqueue(){ const {data,error}=await supabaseAdmin.rpc('enqueue_verified_article_review_jobs_v6'); if(error){const m=errMsg(error);if(m.includes('verified_review_v6_classification_required'))return {blocked:true,enqueued:0};throw error;}return {blocked:false,enqueued:Number(data||0)}; }
async function claim(){ const {data,error}=await supabaseAdmin.rpc('claim_verified_article_review_job_v6',{p_lease_seconds:240}); if(error)throw error; const r=Array.isArray(data)&&isRecord(data[0])?data[0]:null; if(!r)return null; const job={id:text(r.id),articleId:text(r.article_id),pass:text(r.active_pass_kind) as PassKind,token:text(r.lease_token)}; if(!job.id||!job.articleId||!job.token||!['reviewer','critic'].includes(job.pass))throw new StructuralOutputError('claimed article review job invalid'); return job; }
async function getInput(job:NonNullable<Awaited<ReturnType<typeof claim>>>){ const {data,error}=await supabaseAdmin.rpc('get_verified_article_review_input_v6',{p_job_id:job.id,p_lease_token:job.token}); if(error)throw error; if(!isRecord(data)||!isRecord(data.job))throw new StructuralOutputError('article review input malformed'); const body=text(data.verified_crop_ocr_text); if(!body)throw new StructuralOutputError('verified article review text missing'); return {body,reviewerOutput:data.reviewer_output}; }
async function store(job:NonNullable<Awaited<ReturnType<typeof claim>>>,model:string,receipt:Awaited<ReturnType<typeof callJson>>,result:unknown){ const {data,error}=await supabaseAdmin.rpc('store_verified_article_review_pass_v6',{p_job_id:job.id,p_lease_token:job.token,p_pass_kind:job.pass,p_model:model,p_provider_response_id:receipt.providerResponseId,p_prompt_sha256:receipt.promptSha,p_response_sha256:receipt.responseSha,p_result:result});if(error)throw error;return data; }
async function fail(job:NonNullable<Awaited<ReturnType<typeof claim>>>,e:unknown){ const m=errMsg(e); const retryable=e instanceof ProviderError ? e.retryable : false; const {data,error}=await supabaseAdmin.rpc('fail_verified_article_review_job_v6',{p_job_id:job.id,p_lease_token:job.token,p_error:m,p_retryable:retryable});if(error)throw error;return data; }

export async function getVerifiedArticleReviewStatus(){ const [{data:gate,error:ge},{data:jobs,error:je},{data:receipt,error:re}]=await Promise.all([supabaseAdmin.from('verified_article_review_gate_v6').select('*').maybeSingle(),supabaseAdmin.from('verified_article_review_jobs_v6').select('status'),supabaseAdmin.from('current_verified_article_review_corpus_receipt_v7').select('*').maybeSingle()]); if(ge)throw ge;if(je)throw je;if(re)throw re;const counts:Record<string,number>={};for(const r of jobs||[]){const s=text(r.status)||'unknown';counts[s]=(counts[s]||0)+1;}return {gate,jobs:counts,receipt}; }

export async function runVerifiedArticleReviewWorkerStep(){ const enq=await enqueue(); if(enq.blocked)return {stage:'blocked',reason:'verified_classification_required',external_calls:0}; const job=await claim(); if(!job){const {data:gate,error}=await supabaseAdmin.from('verified_article_review_gate_v6').select('review_gate').maybeSingle();if(error)throw error;if(gate?.review_gate==='passed'){const {data,error:re}=await supabaseAdmin.rpc('record_verified_article_review_corpus_receipt_v7');if(re)throw re;return {stage:'review_corpus_sealed',receipt_id:data,external_calls:0};}return {stage:'idle',enqueued:enq.enqueued,external_calls:0};}
  let calls=0; try{const input=await getInput(job);const ms=models();const model=job.pass==='reviewer'?ms.reviewer:ms.critic;const user=JSON.stringify(job.pass==='reviewer'?{task:'verified_full_article_review',article_id:job.articleId,verified_crop_ocr_text:input.body}:{task:'verified_full_article_review_critic',article_id:job.articleId,verified_crop_ocr_text:input.body,reviewer_output:input.reviewerOutput});calls=1;const receipt=await callJson(model,instructions(job.pass),user,job.pass==='reviewer'?REVIEWER_FORMAT:CRITIC_FORMAT);const result=job.pass==='reviewer'?validateReviewer(receipt.value,input.body):validateCritic(receipt.value);const saved=await store(job,model,receipt,result);return {stage:'article_review_pass',article_id:job.articleId,pass_kind:job.pass,result:saved,external_calls:calls};}catch(e){const saved=await fail(job,e);return {stage:'article_review_pass_failed',article_id:job.articleId,pass_kind:job.pass,error:errMsg(e),result:saved,external_calls:calls};}
}
