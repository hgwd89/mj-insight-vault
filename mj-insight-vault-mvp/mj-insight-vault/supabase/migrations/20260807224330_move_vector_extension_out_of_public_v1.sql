alter extension vector set schema extensions;

create or replace function public.complete_article_embedding_job_v4(p_job_id uuid, p_lease_token uuid, p_embedding_vector_text text, p_embedding_model text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  j public.article_embedding_jobs_v4%rowtype;
  i public.formal_article_embedding_input_v4%rowtype;
  v extensions.vector(1536);
begin
  select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'embedding_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'embedding_v4_job_lease_invalid'; end if;
  select * into i from public.formal_article_embedding_input_v4 where article_id=j.article_id;
  if not found then raise exception 'embedding_v4_input_not_current'; end if;
  if i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.embedding_input_sha256<>j.embedding_input_sha256 or i.embedding_input_text<>j.embedding_input_text then raise exception 'embedding_v4_input_stale'; end if;
  if coalesce(btrim(p_embedding_model),'')='' then raise exception 'embedding_v4_model_required'; end if;
  begin v:=p_embedding_vector_text::extensions.vector(1536); exception when others then raise exception 'embedding_v4_vector_invalid'; end;
  if v is null then raise exception 'embedding_v4_vector_missing'; end if;

  insert into public.article_embeddings_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,embedding_input_text,embedding_input_sha256,embedding_vector,embedding_model,embedding_version,quality_status,embedding_job_id,updated_at)
  values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.embedding_input_text,j.embedding_input_sha256,v,left(p_embedding_model,200),j.embedding_version,'passed',j.id,now())
  on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256)
  do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,embedding_input_text=excluded.embedding_input_text,embedding_vector=excluded.embedding_vector,embedding_model=excluded.embedding_model,quality_status='passed',embedding_job_id=excluded.embedding_job_id,updated_at=now();

  update public.article_embedding_jobs_v4 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','job_id',j.id,'article_id',j.article_id);
end $$;

alter function public.complete_article_embedding_job_v4(uuid,uuid,text,text) set search_path = pg_catalog, public, extensions;

create or replace function public.match_articles(query_embedding extensions.vector, match_count integer default 12)
returns table(article_id uuid, headline text, ocr_text text, similarity double precision)
language sql
stable security definer
set search_path = pg_catalog, public, extensions
as $$
  select a.id,a.headline,a.ocr_text,
         1-(e.embedding_vector <=> query_embedding) similarity
  from public.formal_article_embeddings_v3 e
  join public.formal_corpus_articles_v1 a on a.id=e.article_id
  where e.embedding_vector is not null
  order by e.embedding_vector <=> query_embedding
  limit greatest(1,least(coalesce(match_count,12),300));
$$;

revoke execute on function public.match_articles(extensions.vector,integer) from public, anon, authenticated;
grant execute on function public.match_articles(extensions.vector,integer) to service_role;
revoke execute on function public.complete_article_embedding_job_v4(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.complete_article_embedding_job_v4(uuid,uuid,text,text) to service_role;