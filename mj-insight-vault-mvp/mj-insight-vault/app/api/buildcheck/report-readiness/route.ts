import { createHash, timingSafeEqual } from 'node:crypto';
import { createFullCorpusScanRun, getFullCorpusScanRun, runFullCorpusScanBatches } from '@/lib/fullCorpusScan';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;

const BRANCH='agent/inventory-smoke-v2';
const NONCE_SHA256='1c906146632bd86191f3aa40a70e6f3572cc053731342cb7071617f5407214df';

function auth(req:Request){
  if(process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!==BRANCH)return false;
  const nonce=new URL(req.url).searchParams.get('nonce')||'';
  const actual=createHash('sha256').update(nonce).digest();
  const expected=Buffer.from(NONCE_SHA256,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export async function GET(req:Request){
  if(!auth(req))return new Response('Not Found',{status:404});
  const url=new URL(req.url);
  const action=url.searchParams.get('action')||'status';
  if(action==='create'){
    const result=await createFullCorpusScanRun({scope_type:'all',batch_size:50});
    return Response.json(result,{headers:{'cache-control':'no-store'}});
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
