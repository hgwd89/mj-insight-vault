# Testing

## Existing Commands

Run from:

```text
mj-insight-vault-mvp/mj-insight-vault
```

Existing commands:

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Added Local Verification Commands

These commands do not call Google Vision, OpenAI, Supabase, or Vercel:

```bash
npm run test:structure
npm run test:rollup
npm run test:report
npm run test:upload
npm run test:local
```

`npm run test:local` runs all added local guard scripts.

## Role of npm run build

`npm run build` verifies that the Next.js app compiles, route files are valid, TypeScript checks pass, and static pages can be generated.

It does not prove that external APIs, production Supabase data, Google Vision, or OpenAI quota are working.

## Role of npm run lint

`npm run lint` is the project lint command. It should pass before PR or deployment.

If the local Next.js version/tooling rejects `next lint`, report the exact failure instead of replacing it silently.

## External-API-Free Checks

The local scripts verify static guards for:

- upload retry count and OCR image compression constants
- failed-file retention and draft recovery references
- absence of fixed 300 article retrieval limit
- absence of hidden `.limit(160)` in chat analysis paths
- paged article retrieval for `/api/articles` and full-corpus analysis
- monthly rollup month-key and stale handling
- stale-only rollup API mode
- reprocess stale marking
- report prompt keys, evidence links, refutation audit, and quality gate
- article structuring fields, no fabricated unreadable text policy, and quota error handling

These are regression guards, not full behavioral tests.

## Manual External-API Checks

Run only with explicit permission and valid non-secret runtime configuration:

- Upload 2-3 images and verify storage/batch creation.
- Run OCR and verify `ocr_text_raw` and `ocr_json` are stored.
- Confirm OpenAI article structuring creates article candidates without fabricated unreadable details.
- Confirm failed OCR or OpenAI quota returns a clear error and leaves failed state.
- Generate all monthly rollups.
- Add or reprocess an article and verify the relevant month becomes stale.
- Run stale-only rollup regeneration.
- Run `/chat` full analysis and verify monthly rollup context appears when available.
- Open generated report and verify article-title evidence links.

## OCR Quality Test Policy

OCR quality tests should separate:

- image preprocessing/compression behavior
- Google Vision raw OCR response
- OpenAI article structuring
- stored article fields

Do not mark unreadable image text as successfully read. Do not allow fallback paths to save API error text as article body.

## Article Structuring Test Policy

Article structuring checks should verify:

- headline presence
- article date handling
- body text presence
- table/chart/image flags
- source image and batch linkage
- no fabricated numbers or claims
- quota/rate-limit failures remain failures

Fixture-based tests can be added later with local sample JSON and no external API calls.

## Rollup Test Policy

Rollup checks should verify:

- ISO date to month key
- Japanese date to month key
- paged article retrieval
- existing rollup stale marking
- running rollups are not forcibly staled
- stale-only generation path exists

## Report Output Test Policy

Report checks should verify:

- `answer_text` exists
- coverage metadata exists
- evidence matrix exists
- refutation audit exists
- research needs exist
- clickable article-title links exist where evidence is cited
- weak claims are framed as hypotheses or research needs
- OCR reference blocks are not requested as report output

## Upload Interruption and Recovery Test Policy

Manual checks should cover:

- selecting files, entering memo/date, reloading, and restoring draft
- clearing selection and confirming draft disappears
- partial upload failure leaving only failed files
- quota failure stopping cleanly and leaving failed/unprocessed files
- successful upload clearing draft

## PR Before-Merge Checklist

Run:

```bash
npm run lint
npm run build
npm run test:local
```

Then verify:

- changed files are scoped to the task
- no `.env` or secrets are staged
- no production data mutation script was added
- no fixed article count cap was introduced
- no hidden full-analysis cap was introduced
- docs mention only real commands and real files

## Future Test Candidates

- Local fixture tests for `monthKeyFromDate()` through exported pure helpers.
- Local fixture tests for report quality gate using synthetic report JSON.
- Local fixture tests for article structuring fallback using saved OCR text.
- Playwright smoke tests for upload draft recovery and `/rollups` UI.
- CI workflow for `npm run build`, `npm run lint`, and `npm run test:local`.

