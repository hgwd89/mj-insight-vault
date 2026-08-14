import { spawnSync } from 'node:child_process';

const INVENTORY_SMOKE_BRANCH = 'codex/full-corpus-report-production';
const INVENTORY_SMOKE_JOB_ID = '0018d849-75f9-460d-988d-4497e09d7b58';

function runOneInventorySmokeDuringPreviewBuild() {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== INVENTORY_SMOKE_BRANCH) return;

  const workerProgram = String.raw`
(async () => {
  const jobId = '${INVENTORY_SMOKE_JOB_ID}';
  const required = ['OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.log(JSON.stringify({ inventory_v7_one_job_smoke: 'skipped_missing_env', missing }));
    return;
  }

  const [supabaseModule, workerModule] = await Promise.all([
    import('./lib/supabaseAdmin.ts'),
    import('./lib/articleInventoryWorkerV7GroundedOrchestrator.ts')
  ]);
  const supabaseAdmin = supabaseModule.supabaseAdmin || supabaseModule.default?.supabaseAdmin;
  const runStep = workerModule.runArticleInventoryWorkerV7GroundedOrchestratorStep || workerModule.default?.runArticleInventoryWorkerV7GroundedOrchestratorStep;
  if (!supabaseAdmin) throw new Error('inventory_v7_supabase_admin_export_missing');
  if (typeof runStep !== 'function') throw new Error('inventory_v7_worker_export_missing');

  const before = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('id,status,attempt_count,freeze_receipt_id,inventory_version,block_count,requires_third_pass,error_message')
    .eq('id', jobId)
    .maybeSingle();
  if (before.error) throw new Error('inventory_v7_smoke_before_read_failed:' + before.error.message);
  if (!before.data || !['queued', 'running'].includes(String(before.data.status || ''))) {
    console.log(JSON.stringify({ inventory_v7_one_job_smoke: 'skipped_non_runnable_target', job: before.data || null }));
    return;
  }

  let sealed = false;
  const steps = [];
  try {
    const seal = await supabaseAdmin.rpc('seal_inventory_v3_execution_v2', {
      p_reason: 'one-job inventory v7 preview-build smoke 2026-08-14'
    });
    if (seal.error) throw new Error('inventory_v7_smoke_seal_failed:' + seal.error.message);
    sealed = true;

    const priority = await supabaseAdmin
      .from('inventory_execution_priority_v1')
      .update({ job_id: jobId, reason: 'one-job inventory v7 preview-build smoke', updated_at: new Date().toISOString() })
      .eq('singleton', true);
    if (priority.error) throw new Error('inventory_v7_smoke_priority_failed:' + priority.error.message);

    for (let i = 0; i < 8; i += 1) {
      const step = await runStep(jobId);
      const jobRead = await supabaseAdmin
        .from('source_page_article_inventory_jobs_v1')
        .select('status,attempt_count,requires_third_pass,error_message,finished_at,updated_at')
        .eq('id', jobId)
        .maybeSingle();
      if (jobRead.error) throw new Error('inventory_v7_smoke_job_read_failed:' + jobRead.error.message);

      const [passesRead, mappingPassesRead, mappingRead, visualRead] = await Promise.all([
        supabaseAdmin.from('source_page_article_inventory_pass_runs_v1').select('pass_kind,model,provider_response_id,created_at').eq('job_id', jobId).order('created_at'),
        supabaseAdmin.from('source_page_article_inventory_mapping_pass_runs_v2').select('pass_kind,model,provider_response_id,created_at').eq('job_id', jobId).order('created_at'),
        supabaseAdmin.from('source_page_article_inventory_mappings_v2').select('group_fingerprint,article_id,confidence').eq('job_id', jobId),
        supabaseAdmin.from('source_page_inventory_visual_region_evidence_v6').select('pass_kind,article_seq,grounded_block_count,dropped_from_partition,model,provider_response_id').eq('job_id', jobId)
      ]);
      if (passesRead.error) throw new Error('inventory_v7_smoke_pass_read_failed:' + passesRead.error.message);
      if (mappingPassesRead.error) throw new Error('inventory_v7_smoke_mapping_pass_read_failed:' + mappingPassesRead.error.message);
      if (mappingRead.error) throw new Error('inventory_v7_smoke_mapping_read_failed:' + mappingRead.error.message);
      if (visualRead.error) throw new Error('inventory_v7_smoke_visual_read_failed:' + visualRead.error.message);

      const snapshot = {
        iteration: i + 1,
        step,
        job: jobRead.data || null,
        passes: passesRead.data || [],
        mapping_passes: mappingPassesRead.data || [],
        mapping_count: (mappingRead.data || []).length,
        visual_evidence_count: (visualRead.data || []).length
      };
      steps.push(snapshot);
      console.log(JSON.stringify({ inventory_v7_smoke_step: snapshot }));

      const status = String(jobRead.data?.status || '');
      if (['completed', 'needs_review', 'discovery_required', 'failed'].includes(status)) break;
      if (Number(step?.claimed || 0) < 1) break;
    }
  } finally {
    if (sealed) {
      const closeControl = await supabaseAdmin
        .from('inventory_v3_execution_control_v1')
        .update({ enabled: false, reason: 'closed after one-job inventory v7 preview-build smoke', updated_at: new Date().toISOString() })
        .eq('singleton', true);
      if (closeControl.error) console.error('inventory_v7_smoke_close_control_failed', closeControl.error.message);

      const clearPriority = await supabaseAdmin
        .from('inventory_execution_priority_v1')
        .update({ job_id: null, reason: null, updated_at: new Date().toISOString() })
        .eq('singleton', true);
      if (clearPriority.error) console.error('inventory_v7_smoke_clear_priority_failed', clearPriority.error.message);
    }
  }

  const after = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('id,status,attempt_count,requires_third_pass,error_message,finished_at,updated_at')
    .eq('id', jobId)
    .maybeSingle();
  if (after.error) throw new Error('inventory_v7_smoke_after_read_failed:' + after.error.message);
  console.log(JSON.stringify({ inventory_v7_one_job_smoke: 'finished', job_id: jobId, final_job: after.data || null, steps }));
})().catch((error) => {
  console.error('inventory_v7_one_job_smoke_fatal', error?.stack || error);
  process.exit(1);
});
`;

  const child = spawnSync('npx', ['--yes', 'tsx@4.20.3', '-e', workerProgram], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'inherit',
    timeout: 600000
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`inventory v7 one-job smoke exited with status ${child.status}`);
}

runOneInventorySmokeDuringPreviewBuild();

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '25mb' }
  },
  images: { remotePatterns: [] }
};
export default nextConfig;
