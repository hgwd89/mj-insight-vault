create or replace function public.normalize_hierarchical_report_payload_v1(p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  payload jsonb := coalesce(p_payload,'{}'::jsonb);
  generation_path text := coalesce(payload->>'generation_path','');
  run_id_text text := coalesce(payload->>'full_corpus_run_id',payload#>>'{source_coverage,full_corpus_run_id}','');
  v_run_id uuid;
  answer_body text := coalesce(payload->>'answer_text','');
  normalized_body text;
  external_link_count integer := 0;
  evidence_item jsonb;
  normalized_evidence jsonb := '[]'::jsonb;
  article_id_text text;
  actual_batch_index integer;
  corrected_batch_count integer := 0;
begin
  if generation_path <> 'full_corpus_hierarchical_theme_evidence_writer_v1' then
    return payload;
  end if;

  external_link_count := regexp_count(answer_body,'(https?://|www\.)',1,'i');
  normalized_body := regexp_replace(
    answer_body,
    '\[([^]]+)\]\((https?://|www\.)[^)]+\)',
    '\1',
    'gi'
  );
  normalized_body := regexp_replace(
    normalized_body,
    '(https?://|www\.)[^[:space:])]+',
    '',
    'gi'
  );
  normalized_body := regexp_replace(
    normalized_body,
    '詳細はこちら[^。\n]*。',
    '',
    'g'
  );
  normalized_body := btrim(normalized_body);
  payload := jsonb_set(payload,'{answer_text}',to_jsonb(normalized_body),true);

  if run_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_run_id := run_id_text::uuid;
  end if;

  if jsonb_typeof(payload->'evidence_matrix')='array' then
    for evidence_item in
      select value from jsonb_array_elements(payload->'evidence_matrix')
    loop
      article_id_text := coalesce(evidence_item->>'article_id',evidence_item->>'id','');
      actual_batch_index := null;
      if v_run_id is not null and article_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select b.batch_index
          into actual_batch_index
        from public.full_corpus_scan_batches b
        where b.run_id=v_run_id
          and article_id_text::uuid=any(b.article_ids)
        limit 1;
      end if;
      if actual_batch_index is not null then
        if coalesce(evidence_item->>'batch_index','') <> actual_batch_index::text then
          corrected_batch_count := corrected_batch_count + 1;
        end if;
        evidence_item := jsonb_set(evidence_item,'{batch_index}',to_jsonb(actual_batch_index),true);
      end if;
      normalized_evidence := normalized_evidence || jsonb_build_array(evidence_item);
    end loop;
    payload := jsonb_set(payload,'{evidence_matrix}',normalized_evidence,true);
  end if;

  payload := jsonb_set(
    payload,
    '{database_normalization}',
    jsonb_build_object(
      'version','hierarchical_payload_normalizer_v1',
      'external_links_removed',external_link_count,
      'batch_indices_corrected',corrected_batch_count,
      'content_claims_modified',false
    ),
    true
  );
  return payload;
end;
$function$;

create or replace function public.normalize_hierarchical_report_before_gate_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  new.answer_json := public.normalize_hierarchical_report_payload_v1(new.answer_json);
  if coalesce(new.answer_json->>'generation_path','')='full_corpus_hierarchical_theme_evidence_writer_v1' then
    new.answer_text := coalesce(new.answer_json->>'answer_text',new.answer_text);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_0000_normalize_hierarchical_report_v1 on public.chat_reports;
create trigger trg_0000_normalize_hierarchical_report_v1
before insert or update of answer_json on public.chat_reports
for each row execute function public.normalize_hierarchical_report_before_gate_v1();
