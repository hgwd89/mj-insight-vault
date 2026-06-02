# Architecture

## Purpose

MJ Insight Vault captures Nikkei MJ article images, runs OCR, structures articles, stores article evidence, builds monthly rollups, and generates research-oriented reports.

The app is designed to preserve evidence first. Report generation should separate facts from hypotheses, include clickable article evidence links, and surface refutation and research needs.

## App Root

```text
mj-insight-vault-mvp/mj-insight-vault
```

Run npm commands from this directory.

## Technology Stack

- Next.js App Router
- React
- TypeScript
- Supabase database and storage
- Google Vision OCR
- OpenAI for article structuring, embeddings, rollups, and reports
- Zod for article structuring schema validation
- Tailwind CSS

## Major Features

### Image Upload

Primary upload UI is in `components/UploadFormStable.tsx`.

It handles:

- image selection
- high-quality OCR-oriented compression
- retry through `withRetry()`
- failed-file tracking
- IndexedDB draft recovery through `lib/uploadDraftStore.ts`
- continuation after reload where possible

### OCR

`lib/vision.ts` calls Google Vision `DOCUMENT_TEXT_DETECTION`.

`app/api/source-images/[id]/process/route.ts` downloads the uploaded image from Supabase storage, runs OCR, stores raw OCR text and raw OCR JSON, then calls article structuring.

### Article Structuring

`lib/articleSegmentation.ts` uses OpenAI Responses API with image input and Google Vision OCR text as supporting context.

The intended boundary:

- Google Vision output is raw OCR evidence.
- OpenAI article structuring reconstructs article candidates from the image and OCR context.
- The structuring prompt forbids fabricated numbers and unsupported interpretation.
- Quota/rate-limit failures are not converted into article text.

### Article Storage

Structured candidates are inserted into `articles` by:

- `app/api/source-images/[id]/process/route.ts`
- `app/api/source-images/[id]/reprocess/route.ts`

Stored article rows include source image linkage, batch linkage, headline, date, article text, type, and table/chart/image flags.

### Article Listing

`app/api/articles/route.ts` pages through article rows using `PAGE_SIZE = 1000` and `.range(...)`.

It filters deleted/excluded/rejected rows after retrieval and returns metadata such as `total_fetched`, `total_visible`, `page_size`, and `limit_removed`.

### Batch Management

Batch pages and APIs are under:

- `app/batches/page.tsx`
- `app/batches/[id]/page.tsx`
- `app/api/batches/route.ts`
- `app/api/batches/[id]/route.ts`

Batch completion is updated when source images are done, failed, or deleted.

### Monthly Rollups

Monthly rollups are implemented in:

- `lib/monthlyRollups.ts`
- `lib/monthlyRollupContext.ts`
- `app/api/rollups/monthly/route.ts`
- `app/rollups/page.tsx`
- `components/RollupsOperationGuide.tsx`

`lib/monthlyRollups.ts` computes month keys, supports ISO-like dates and Japanese dates, pages through article rows, generates rollups, and marks existing rollups stale when new articles are added for the same month.

### Stale Management

Article creation and reprocessing call `markMonthlyRollupsStaleForArticleDates()`.

The stale marker updates existing monthly rollups and avoids forcing currently running rollups into stale state.

`app/api/rollups/monthly/route.ts` supports:

- all-month generation
- stale-only generation
- single-month generation

### Report Generation

Report generation is handled by:

- `lib/chatRouteNo160.ts`
- `lib/chatRouteCore.ts`
- `app/api/chat/route.ts`
- `app/api/chat/jobs/[id]/run/route.ts`
- `lib/reportPrompt.ts`
- `lib/chatAnalysisQualityGate.ts`

Full-corpus analysis uses paged article retrieval and low-cost scanning before final report generation. It should not pass all raw article text directly to GPT-5 every time.

Reports are stored in `chat_reports`.

## Processing Flows

### Upload to OCR

1. User selects images in `/upload`.
2. `UploadFormStable` compresses images for OCR.
3. `/api/upload/start` creates a batch.
4. `/api/upload/image` stores image metadata and storage object.
5. If auto OCR is enabled, `/api/source-images/[id]/process` runs.

### OCR to Article Storage

1. API downloads source image from Supabase storage.
2. `runDocumentOcr()` calls Google Vision.
3. Raw OCR text and JSON are stored on `source_images`.
4. `segmentArticlesFromImage()` structures article candidates.
5. Articles are inserted into `articles`.
6. Embeddings are generated when OpenAI embedding is available.
7. Affected monthly rollups are marked stale.

### Reprocess Old Data

`app/api/source-images/[id]/reprocess/route.ts` reruns OCR and structuring for a source image, soft-deletes old articles from that image, inserts new articles, and marks affected rollups stale.

### Monthly Rollup Generation

1. `/rollups` calls `GET /api/rollups/monthly`.
2. The API returns article months, existing rollups, stale months, and month counts.
3. User can generate all months, stale months only, or one month.
4. Rollups are saved to `monthly_rollups`.

### Report Generation

1. `/chat` submits analysis instructions.
2. Direct chat and job chat use `lib/chatRouteNo160.ts`.
3. Full analysis fetches all active articles through `fetchAllWideArticles()`.
4. Articles are scanned with a low-cost model when needed.
5. Final report uses selected articles and report prompt rules.
6. Quality gate ensures coverage, evidence matrix, refutation audit, and article links are present where possible.
7. Result is saved in `chat_reports`.

## Environment Variables

The code references these environment variable names:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `APP_PASSWORD`
- `GOOGLE_CLOUD_CREDENTIALS`
- `OPENAI_API_KEY`
- `OPENAI_CHAT_MODEL`
- `OPENAI_CHAT_MODELS`
- `OPENAI_SCAN_MODEL`
- `OPENAI_VISION_MODEL`
- `OPENAI_EMBEDDING_MODEL`

Exact production values are not documented here and must not be committed.

## Unverified Items

- Production Supabase table contents are not verified by this document.
- Production Vercel project settings are not verified by this document.
- Google Vision and OpenAI quota/billing state are not verified by local tests.
- Exact browser behavior on all mobile devices is not verified by local static tests.

