create table if not exists public.source_image_near_duplicate_audit_v1 (
  source_image_id_a uuid not null references public.source_images(id) on delete cascade,
  source_image_id_b uuid not null references public.source_images(id) on delete cascade,
  article_date text not null,
  raw_ocr_similarity numeric not null,
  source_norm_hash_a text not null,
  source_norm_hash_b text not null,
  detected_at timestamptz not null default now(),
  primary key(source_image_id_a,source_image_id_b),
  check(source_image_id_a<source_image_id_b),
  check(raw_ocr_similarity>=0 and raw_ocr_similarity<=1)
);

truncate public.source_image_near_duplicate_audit_v1;

insert into public.source_image_near_duplicate_audit_v1(
  source_image_id_a,source_image_id_b,article_date,raw_ocr_similarity,source_norm_hash_a,source_norm_hash_b
)
with pages as (
  select s.id,s.ocr_text_raw,coalesce(min(a.article_date),'') article_date,
         encode(extensions.digest(convert_to(lower(regexp_replace(coalesce(s.ocr_text_raw,''),'[[:space:]]+','','g')),'UTF8'),'sha256'),'hex') norm_hash
  from public.source_images s
  left join public.articles a on a.source_image_id=s.id
  where coalesce(s.ocr_text_raw,'')<>''
  group by s.id,s.ocr_text_raw
)
select p1.id,p2.id,p1.article_date,similarity(p1.ocr_text_raw,p2.ocr_text_raw),p1.norm_hash,p2.norm_hash
from pages p1
join pages p2 on p1.id<p2.id and p1.article_date=p2.article_date and p1.article_date<>'' and p1.norm_hash<>p2.norm_hash
where similarity(p1.ocr_text_raw,p2.ocr_text_raw)>=0.99;

revoke all on public.source_image_near_duplicate_audit_v1 from public,anon,authenticated;
grant select on public.source_image_near_duplicate_audit_v1 to postgres,service_role;