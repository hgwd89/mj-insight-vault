import { createHash, timingSafeEqual } from 'node:crypto';
import { runArticleInventoryWorkerV3Step, getArticleInventoryV3Status } from '@/lib/articleInventoryWorkerV3';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'agent/inventory-smoke-v2';
const NONCE_SHA256 = '1c906146632bd86191f3aa40a70e6f3572cc053731342cb7071617f5407214df';
const CASES: Record<string, string> = {
  case1: '0b5b56fe-1e64-4cff-8432-eb48e9688e55',
  case2: '8351828e-33e2-446e-9485-f4d6fa3b2dcd'
};

function auth(req: Request) {
  if (process.env.VERCEL_GIT_COMMIT_REF !== BRANCH || process.env.VERCEL_ENV !== 'preview') return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJob(id: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('id,status,requires_third_pass,attempt_count,error_message,existing_article_count,block_count,updated_at,finished_at')
    .eq('id', id)
    .single();
  if (error) throw error;

  const [{ data: passes, error: passError }, { data: mappingPasses, error: mappingError }] = await Promise.all([
    supabaseAdmin
      .from('source_page_article_inventory_pass_runs_v1')
      .select('pass_kind,model,provider_response_id,created_at')
      .eq('job_id', id)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('source_page_article_inventory_mapping_pass_runs_v2')
      .select('pass_kind,model,provider_response_id,created_at')
      .eq('job_id', id)
      .order('created_at', { ascending: true })
  ]);
  if (passError) throw passError;
  if (mappingError) throw mappingError;

  const { data: consensus, error: consensusError } = await supabaseAdmin.rpc('inventory_consensus_source_v3', { p_job_id: id });
  if (consensusError) throw consensusError;

  return {
    job: data,
    consensus_source_v3: typeof consensus === 'string' ? consensus : null,
    pass_receipts: passes || [],
    mapping_pass_receipts: mappingPasses || []
  };
}

export async function GET(req: Request) {
  if (!auth(req)) return new Response('Not Found', { status: 404 });
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'status';
    const caseName = url.searchParams.get('case') || 'case1';
    const jobId = CASES[caseName];
    if (!jobId) return Response.json({ error: 'unknown fixed smoke case' }, { status: 400 });

    if (action === 'status') {
      return Response.json({ case: caseName, ...(await readJob(jobId)), gate: await getArticleInventoryV3Status() }, { headers: { 'cache-control': 'no-store' } });
    }
    if (action === 'step') {
      const step = await runArticleInventoryWorkerV3Step(jobId);
      return Response.json({ case: caseName, step, ...(await readJob(jobId)), gate: await getArticleInventoryV3Status() }, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'inventory v3 smoke error';
    return Response.json({ error: message }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
