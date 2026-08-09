create table if not exists public.source_image_equivalence_reviews_v1 (
  source_image_id uuid not null references public.source_images(id) on delete cascade,
  canonical_source_image_id uuid not null references public.source_images(id),
  review_version text not null default 'near_raw_ocr_similarity_review_v1',
  raw_ocr_similarity double precision not null check(raw_ocr_similarity>=0.99 and raw_ocr_similarity<=1.0),
  publication_date date not null,
  decision text not null default 'equivalent' check(decision='equivalent'),
  reason text not null,
  created_at timestamptz not null default now(),
  primary key(source_image_id,review_version),
  check(source_image_id<>canonical_source_image_id)
);

with recursive chosen(root,canonical_source) as (values
 ('047742ff-713d-40c3-99e5-684bbbf4a2d6'::uuid,'b905c0bd-c9af-4822-9e12-cfb93c595c03'::uuid),('09fa39e2-4c8c-4ad5-9f4c-88d4d65789f3'::uuid,'c87025c2-0d3f-434a-a66c-b35104c9dcee'::uuid),('12dc39fb-cbab-4627-875c-026a8b749530'::uuid,'12dc39fb-cbab-4627-875c-026a8b749530'::uuid),('1babb1aa-7991-4a66-b54e-1a6c64f65417'::uuid,'239796f6-65b7-4538-a729-2a9ed14729ee'::uuid),('209bc08e-c896-4835-b341-33ed6b042479'::uuid,'209bc08e-c896-4835-b341-33ed6b042479'::uuid),('21afe570-81bd-4692-ad48-dd62d3970c27'::uuid,'5fa0d6d5-8bf7-40a6-8972-1f4f04038119'::uuid),('2ab11847-1fe1-40b3-b770-16a238e44432'::uuid,'2ab11847-1fe1-40b3-b770-16a238e44432'::uuid),('2b4ac747-3c45-45a4-b75b-95cdc1df85d1'::uuid,'46b1928d-7c12-4e36-8b0b-7cca1a09e167'::uuid),('3260ee6b-3dff-4b18-8acb-9c5683827fa7'::uuid,'6d44b375-11ae-4543-93d3-a73bdf0274f7'::uuid),('32e2720d-1022-46c6-81fd-96ecf5fe7e27'::uuid,'32e2720d-1022-46c6-81fd-96ecf5fe7e27'::uuid),('39679941-3c07-453a-a52e-c11a272ca8db'::uuid,'59533428-b909-4892-aa0d-ba17d5394401'::uuid),('43d20b7f-ef42-426c-85e3-a5742c4c96ec'::uuid,'54e6d4df-cda5-4f0f-8c79-8ba207f70bb4'::uuid),('698bfee8-ea03-4376-8125-15f828871226'::uuid,'698bfee8-ea03-4376-8125-15f828871226'::uuid),('73021cdd-bf45-4e7c-81e9-23f1c50bb2d6'::uuid,'73021cdd-bf45-4e7c-81e9-23f1c50bb2d6'::uuid),('a1f1ad80-7b0b-4f86-bea2-4aa282c1997b'::uuid,'a1f1ad80-7b0b-4f86-bea2-4aa282c1997b'::uuid)
), edges as (
 select n.source_image_id_a a,n.source_image_id_b b
 from public.source_image_near_duplicate_audit_v1 n
 where n.raw_ocr_similarity>=0.99
   and n.source_image_id_a in (select distinct source_image_id from public.formal_corpus_articles_v1)
   and n.source_image_id_b in (select distinct source_image_id from public.formal_corpus_articles_v1)
), adj as (select a src,b dst from edges union all select b,a from edges), nodes as (select src node from adj union select dst from adj), reach(root,node) as (select node,node from nodes union select r.root,a.dst from reach r join adj a on a.src=r.node), comps as (select node,min(root::text)::uuid root from reach group by node), losers as (
 select c.node loser,ch.canonical_source
 from comps c join chosen ch using(root)
 where c.node<>ch.canonical_source
), reviewed as (
 select l.loser,l.canonical_source,
   (select max(n.raw_ocr_similarity) from public.source_image_near_duplicate_audit_v1 n where (n.source_image_id_a=l.loser and n.source_image_id_b=l.canonical_source) or (n.source_image_id_b=l.loser and n.source_image_id_a=l.canonical_source)) sim,
   dl.publication_date loser_date,dc.publication_date canonical_date,
   sl.batch_id loser_batch,sc.batch_id canonical_batch,sl.raw_ocr_sha256 loser_raw_sha,sc.raw_ocr_sha256 canonical_raw_sha
 from losers l
 join public.source_publication_date_effective_v1 dl on dl.source_image_id=l.loser
 join public.source_publication_date_effective_v1 dc on dc.source_image_id=l.canonical_source
 join public.source_images sl on sl.id=l.loser
 join public.source_images sc on sc.id=l.canonical_source
 where dl.publication_date=dc.publication_date
), audit_insert as (
 insert into public.source_image_equivalence_reviews_v1(source_image_id,canonical_source_image_id,raw_ocr_similarity,publication_date,reason)
 select loser,canonical_source,sim,loser_date,'reviewed_same_newspaper_page_raw_ocr_similarity_ge_0_99_v1'
 from reviewed
 where sim>=0.99
 on conflict(source_image_id,review_version) do update set canonical_source_image_id=excluded.canonical_source_image_id,raw_ocr_similarity=excluded.raw_ocr_similarity,publication_date=excluded.publication_date,reason=excluded.reason
 returning source_image_id,canonical_source_image_id
), rehomed as (
 update public.articles a
 set original_source_image_id=coalesce(a.original_source_image_id,a.source_image_id),
     original_batch_id=coalesce(a.original_batch_id,a.batch_id),
     source_rehoming_reason='near_raw_ocr_similarity_reviewed_equivalent_source_v1',
     source_image_id=r.canonical_source,
     batch_id=r.canonical_batch,
     source_ocr_sha256=r.canonical_raw_sha,
     provenance_json=coalesce(a.provenance_json,'{}'::jsonb)||jsonb_build_object(
       'source_rehomed_from_image_id',r.loser::text,
       'source_rehomed_to_image_id',r.canonical_source::text,
       'source_rehoming_reason','near_raw_ocr_similarity_reviewed_equivalent_source_v1',
       'reviewed_raw_ocr_similarity',r.sim,
       'original_source_raw_ocr_sha256',r.loser_raw_sha,
       'effective_source_raw_ocr_sha256',r.canonical_raw_sha
     ),
     updated_at=now()
 from reviewed r
 where r.sim>=0.99 and a.source_image_id=r.loser
   and (a.status is null or a.status not in ('deleted','excluded','rejected'))
 returning a.id
), source_marked as (
 update public.source_images s
 set duplicate_of_source_image_id=r.canonical_source,
     duplicate_reason='near_raw_ocr_similarity_reviewed_equivalent_source_v1'
 from reviewed r
 where r.sim>=0.99 and s.id=r.loser
 returning s.id
)
select (select count(*) from rehomed)::integer rehomed_articles,(select count(*) from source_marked)::integer duplicate_sources_marked,(select count(*) from audit_insert)::integer reviews_recorded;