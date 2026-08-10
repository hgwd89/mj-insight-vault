import { createHash, timingSafeEqual } from 'node:crypto';
import { getFullCorpusScanRun, runFullCorpusScanBatches } from '@/lib/fullCorpusScan';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;

const BRANCH='agent/inventory-smoke-v2';
const NONCE_SHA256='1c906146632bd86191f3aa40a70e6f3572cc053731342cb7071617f5407214df';

function auth(req:Request){
  if(process.env.VERCEL_GIT_COMMIT_REF!==BRANCH)return false;
  const url=new URL(req.url);
  const local=(url.hostname==='127.0.0.1'||url.hostname==='localhost')&&process.env.VERCEL==='1';
  if(local)return true;
  if(process.env.VERCEL_ENV!=='preview')return false;
  const nonce=url.searchParams.get('nonce')||'';
  const actual=createHash('sha256').update(nonce).digest();
  const expected=Buffer.from(NONCE_SHA256,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

async function createFormalRun(){
  const model=process.env.OPENAI_SCAN_MODEL||'gpt-4o-mini';
  const {data,error}=await supabaseAdmin.rpc('create_formal_full_corpus_scan_v1',{
    p_model:model,
    p_batch_size:50,
    p_prompt_version:'full_corpus_batch_v2'
  });
  if(error)throw error;
  const runId=String((data as Record<string,unknown> | null)?.run_id||'');
  if(!runId)throw new Error('formal full corpus scan RPC returned no run_id');
  return getFullCorpusScanRun(runId);
}

export async function GET(req:Request){
  if(!auth(req))return new Response('Not Found',{status:404});
  const url=new URL(req.url);
  const action=url.searchParams.get('action')||'status';
  if(action==='create'){
    return Response.json(await createFormalRun(),{headers:{'cache-control':'no-store'}});
  }
  if(action==='advance'){
    const id=url.searchParams.get('id')||'';
    if(!id)return Response.json({error:'id required'},{status:400});
    const limit=Math.max(1,Math.min(10,Number(url.searchParams.get('limit')||10)));
    const result=await runFullCorpusScanBatches(id,limit);
    return Response.json(result,{headers:{'cache-control':'no-store'}});
  }
  if(action==='status'){
    const id=url.searchParams.get('id')||'';
    if(!id)return Response.json({error:'id required'},{status:400});
    return Response.json(await getFullCorpusScanRun(id),{headers:{'cache-control':'no-store'}});
  }
  if(action==='report'){
    const query=url.searchParams.get('query')||'現在の全記事を横断し、生活者の変化・行動シグナル・矛盾・今後検証すべき仮説を根拠記事付きで整理してください。';
    const result=await runChatAnalysis({query,target_scope:'all',require_full_corpus:true});
    return Response.json(result,{headers:{'cache-control':'no-store'}});
  }
  return Response.json({error:'unknown action'},{status:400});
}
