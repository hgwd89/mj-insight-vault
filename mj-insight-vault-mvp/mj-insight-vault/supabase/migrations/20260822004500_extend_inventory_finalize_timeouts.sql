alter function public.resolve_inventory_mapping_auto_v3(uuid, uuid)
  set statement_timeout to '90s';

alter function public.finalize_source_page_article_inventory_job_v3(uuid, uuid)
  set statement_timeout to '90s';

alter function public.store_visual_inventory_consensus_v4(uuid, uuid, jsonb)
  set statement_timeout to '90s';
