begin;

create index if not exists ocr_verification_crop_ocr_v4_article_idx
  on public.ocr_verification_crop_ocr_v4(article_id);

create index if not exists ocr_verification_page_jobs_v2_evidence_source_idx
  on public.ocr_verification_page_jobs_v2(evidence_source_image_id);

create index if not exists ocr_verification_page_jobs_v2_page_identity_source_idx
  on public.ocr_verification_page_jobs_v2(page_identity_source_image_id);

create index if not exists ocr_verification_transcriptions_v2_article_idx
  on public.ocr_verification_transcriptions_v2(article_id);

create index if not exists source_region_materialization_receipts_v6_evidence_source_idx
  on public.source_region_materialization_receipts_v6(evidence_source_image_id);

create index if not exists category_classification_corpus_receipts_v7_duplicate_audit_idx
  on public.category_classification_corpus_receipts_v7(duplicate_audit_run_id);

create index if not exists category_classification_corpus_receipts_v7_freeze_idx
  on public.category_classification_corpus_receipts_v7(freeze_receipt_id);

commit;