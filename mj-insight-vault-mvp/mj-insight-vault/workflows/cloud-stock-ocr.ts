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

export async function cloudStockOcrWorkflow() {
  'use workflow';

  let completed = 0;
  let failed = 0;

  // GPT-first architecture: OCR makes the source searchable immediately.
  // Paid article segmentation is optional enrichment and is never launched
  // from the default background workflow.
  for (let index = 0; index < 5000; index += 1) {
    const source = await claimNextSource();
    if (!source) break;

    try {
      await runOcrForSource(source);
      completed += 1;
    } catch {
      failed += 1;
    }
  }

  return { completed, failed, articleOrganizationStarted: false };
}
