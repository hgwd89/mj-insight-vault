type SourceRow = Record<string, unknown>;

async function claimNextSource(): Promise<SourceRow | null> {
  'use step';
  const lib = await import('@/lib/cloudStockBackgroundOcr');
  const jwt = await lib.getOwnerNeonJwt();
  return lib.claimNextOcr(jwt);
}

async function runOcrForSource(source: SourceRow) {
  'use step';
  const lib = await import('@/lib/cloudStockBackgroundOcr');
  const jwt = await lib.getOwnerNeonJwt();
  return lib.runClaimedOcr(jwt, source);
}

async function organizeSource(sourceFileId: string) {
  'use step';
  const lib = await import('@/lib/cloudStockBackgroundOcr');
  const jwt = await lib.getOwnerNeonJwt();
  return lib.organizeOneSource(jwt, sourceFileId);
}

async function organizeSourcesBatch(sourceFileIds: string[]) {
  'use step';
  const lib = await import('@/lib/cloudStockBackgroundOcr');
  const jwt = await lib.getOwnerNeonJwt();
  const results = await Promise.allSettled(
    sourceFileIds.map((sourceFileId) => lib.organizeOneSource(jwt, sourceFileId))
  );
  return {
    completed: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length
  };
}

async function pendingOrganizeSources() {
  'use step';
  const lib = await import('@/lib/cloudStockBackgroundOcr');
  const jwt = await lib.getOwnerNeonJwt();
  return lib.pendingOrganizeSourceIds(jwt);
}

export async function cloudStockOcrWorkflow() {
  'use workflow';

  let completed = 0;
  let failed = 0;
  let organizeCompleted = 0;
  let organizeFailed = 0;

  for (let index = 0; index < 5000; index += 1) {
    const source = await claimNextSource();
    if (!source) break;

    const sourceFileId = typeof source.id === 'string' ? source.id : '';

    try {
      await runOcrForSource(source);
      completed += 1;
    } catch {
      failed += 1;
      continue;
    }

    if (sourceFileId) {
      try {
        await organizeSource(sourceFileId);
        organizeCompleted += 1;
      } catch {
        organizeFailed += 1;
      }
    }
  }

  const organizeBacklog = await pendingOrganizeSources();
  for (let index = 0; index < organizeBacklog.length; index += 3) {
    const batch = organizeBacklog.slice(index, index + 3);
    const result = await organizeSourcesBatch(batch);
    organizeCompleted += result.completed;
    organizeFailed += result.failed;
  }

  return { completed, failed, organizeCompleted, organizeFailed };
}
